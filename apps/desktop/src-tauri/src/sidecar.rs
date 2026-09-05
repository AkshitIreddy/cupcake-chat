use crate::error::{HostError, HostResult};
use crate::file_handles::InternalFileGrant;
use crate::manifest::verify_sidecar_directory;
use crate::models::{
    RuntimeEvent, RuntimeMode, RuntimeResponse, RuntimeState, RuntimeStatus, RUNTIME_EVENT_NAME,
    RUNTIME_STATUS_EVENT_NAME,
};
use crate::process_job::ProcessJob;
use base64::prelude::*;
use chrono::{SecondsFormat, Utc};
use cupcake_tool_broker::framing::{
    read_protocol_frame, write_protocol_frame, DEFAULT_MAX_FRAME_BYTES,
};
use cupcake_tool_broker::protocol::{
    uuid_v7, MessageType, ProtocolEnvelope, ProtocolLineage, ReplayGuard,
};
use cupcake_tool_broker::PROTOCOL_VERSION;
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
const MIN_REQUEST_TIMEOUT_MS: u64 = 1_000;
// CUDA model mapping can legitimately take close to the runtime's 180-second
// readiness bound on first load. Keep a finite host ceiling with enough margin
// for the runtime to return its own specific readiness failure.
const MAX_REQUEST_TIMEOUT_MS: u64 = 300_000;
const MAX_RESTARTS: u32 = 3;

type PendingResponses = Arc<Mutex<HashMap<Uuid, Sender<ProtocolEnvelope>>>>;

struct BrokerConnection {
    child: Child,
    writer: BufWriter<ChildStdin>,
    pending: PendingResponses,
    secret: Arc<Zeroizing<Vec<u8>>>,
    session_id: Uuid,
    sequences: HashMap<Uuid, u64>,
    _job: ProcessJob,
    generation: u64,
}

impl BrokerConnection {
    fn send(
        &mut self,
        message_type: MessageType,
        correlation_id: Uuid,
        payload: Map<String, Value>,
        timeout: Duration,
    ) -> HostResult<()> {
        let sequence = self
            .sequences
            .entry(correlation_id)
            .and_modify(|value| *value += 1)
            .or_insert(1);
        let envelope = ProtocolEnvelope::unsigned(
            uuid_v7(),
            correlation_id,
            self.session_id,
            *sequence,
            (Utc::now()
                + chrono::Duration::from_std(timeout)
                    .unwrap_or_else(|_| chrono::Duration::seconds(30)))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
            ProtocolLineage::default(),
            message_type,
            payload,
        )
        .sign(self.secret.as_slice())
        .map_err(|_| HostError::internal("The broker request could not be authenticated"))?;
        write_protocol_frame(&mut self.writer, &envelope, DEFAULT_MAX_FRAME_BYTES)
            .map_err(|_| HostError::unavailable("The local broker connection was interrupted"))
    }

    fn send_sensitive(
        &mut self,
        message_type: MessageType,
        correlation_id: Uuid,
        payload: Map<String, Value>,
        timeout: Duration,
    ) -> HostResult<()> {
        let sequence = self
            .sequences
            .entry(correlation_id)
            .and_modify(|value| *value += 1)
            .or_insert(1);
        let mut envelope = ProtocolEnvelope::unsigned(
            uuid_v7(),
            correlation_id,
            self.session_id,
            *sequence,
            (Utc::now()
                + chrono::Duration::from_std(timeout)
                    .unwrap_or_else(|_| chrono::Duration::seconds(30)))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
            ProtocolLineage::default(),
            message_type,
            payload,
        )
        .sign(self.secret.as_slice())
        .map_err(|_| HostError::internal("The provider request could not be authenticated"))?;
        let result = write_protocol_frame(&mut self.writer, &envelope, DEFAULT_MAX_FRAME_BYTES)
            .map_err(|_| HostError::unavailable("The local broker connection was interrupted"));
        if let Some(Value::String(secret)) = envelope
            .payload
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .and_then(|params| params.get_mut("secret"))
        {
            secret.zeroize();
        }
        result
    }

    fn subscribe(&self, correlation_id: Uuid) -> Receiver<ProtocolEnvelope> {
        let (sender, receiver) = mpsc::channel();
        lock_pending(&self.pending).insert(correlation_id, sender);
        receiver
    }

    fn unsubscribe(&self, correlation_id: Uuid) {
        lock_pending(&self.pending).remove(&correlation_id);
    }
}

impl Drop for BrokerConnection {
    fn drop(&mut self) {
        self.sequences.clear();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct SupervisorInner {
    connection: Option<BrokerConnection>,
    status: RuntimeStatus,
    grants: HashMap<String, InternalFileGrant>,
    restart_count: u32,
    generation: u64,
    stopping: bool,
}

pub struct SidecarSupervisor {
    app: AppHandle,
    sidecar_directory: PathBuf,
    data_directory: PathBuf,
    inner: Mutex<SupervisorInner>,
}

pub struct SensitiveProviderRequest {
    pub provider: String,
    pub secret: Zeroizing<String>,
    pub base_url: Option<String>,
    pub organization: Option<String>,
    pub account_id: Option<String>,
    pub model_id: Option<String>,
    pub display_name: Option<String>,
}

impl SidecarSupervisor {
    pub fn new(app: AppHandle, sidecar_directory: PathBuf, data_directory: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            app,
            sidecar_directory,
            data_directory,
            inner: Mutex::new(SupervisorInner::default()),
        })
    }

    pub fn start(self: &Arc<Self>) -> HostResult<()> {
        let mut inner = self.lock();
        if inner.connection.is_some() || inner.stopping {
            return Ok(());
        }
        self.set_status_locked(
            &mut inner,
            RuntimeState::Starting,
            RuntimeMode::Broker,
            None,
            None,
        );
        match self.launch_locked(&mut inner) {
            Ok(generation) => {
                drop(inner);
                self.spawn_monitor(generation);
                Ok(())
            }
            Err(error) => {
                let detail = format!("{}: {}", error.code, error.message);
                self.set_status_locked(
                    &mut inner,
                    RuntimeState::Crashed,
                    RuntimeMode::Disabled,
                    None,
                    Some(detail),
                );
                Err(error)
            }
        }
    }

    pub fn status(&self) -> RuntimeStatus {
        self.lock().status.clone()
    }

    pub fn request(
        &self,
        method: String,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> RuntimeResponse {
        let timeout = Duration::from_millis(
            timeout_ms
                .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS)
                .clamp(MIN_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS),
        );
        let correlation = uuid_v7();
        let payload = object(json!({"method": method, "params": params}));
        let (receiver, generation) = {
            let mut inner = self.lock();
            let Some(connection) = inner.connection.as_mut() else {
                return RuntimeResponse::failure(
                    "RUNTIME_NOT_READY",
                    "The local runtime is not ready",
                    true,
                );
            };
            let receiver = connection.subscribe(correlation);
            if let Err(error) = connection.send(MessageType::Request, correlation, payload, timeout)
            {
                connection.unsubscribe(correlation);
                let _ = connection.child.kill();
                return RuntimeResponse::failure(error.code, error.message, error.retryable);
            }
            (receiver, connection.generation)
        };
        match receive_for(receiver, correlation, MessageType::Response, timeout) {
            Ok(payload) => normalize_response(payload),
            Err(error) => {
                self.kill_generation(generation);
                RuntimeResponse::failure(error.code, error.message, error.retryable)
            }
        }
    }

    pub fn cancel(&self, target_id: &str) -> bool {
        let Ok(target) = Uuid::parse_str(target_id) else {
            return false;
        };
        let mut inner = self.lock();
        let Some(connection) = inner.connection.as_mut() else {
            return false;
        };
        connection
            .send(
                MessageType::Cancel,
                uuid_v7(),
                object(json!({"targetId": target})),
                Duration::from_secs(30),
            )
            .is_ok()
    }

    pub fn provider_request(
        &self,
        method: &'static str,
        mut request: SensitiveProviderRequest,
    ) -> RuntimeResponse {
        let correlation = uuid_v7();
        let secret_value = std::mem::take(&mut *request.secret);
        let mut params = Map::new();
        params.insert("provider".into(), Value::String(request.provider));
        params.insert("secret".into(), Value::String(secret_value));
        if let Some(value) = request.base_url {
            params.insert("baseUrl".into(), Value::String(value));
        }
        if let Some(value) = request.organization {
            params.insert("organization".into(), Value::String(value));
        }
        if let Some(value) = request.account_id {
            params.insert("accountId".into(), Value::String(value));
        }
        if let Some(value) = request.model_id {
            params.insert("modelId".into(), Value::String(value));
        }
        if let Some(value) = request.display_name {
            params.insert("displayName".into(), Value::String(value));
        }
        let payload = object(json!({"method": method, "params": params}));
        let (receiver, generation) = {
            let mut inner = self.lock();
            let Some(connection) = inner.connection.as_mut() else {
                return RuntimeResponse::failure(
                    "RUNTIME_NOT_READY",
                    "The local runtime is not ready",
                    true,
                );
            };
            let receiver = connection.subscribe(correlation);
            if let Err(error) = connection.send_sensitive(
                MessageType::Request,
                correlation,
                payload,
                Duration::from_secs(60),
            ) {
                connection.unsubscribe(correlation);
                let _ = connection.child.kill();
                return RuntimeResponse::failure(error.code, error.message, error.retryable);
            }
            (receiver, connection.generation)
        };
        match receive_for(
            receiver,
            correlation,
            MessageType::Response,
            Duration::from_secs(60),
        ) {
            Ok(payload) => normalize_response(payload),
            Err(error) => {
                self.kill_generation(generation);
                RuntimeResponse::failure(error.code, error.message, error.retryable)
            }
        }
    }

    pub fn provider_disconnect(&self, provider: String) -> RuntimeResponse {
        self.request(
            "providers.disconnect".into(),
            json!({"provider": provider}),
            Some(60_000),
        )
    }

    pub fn register_file_grant(&self, grant: InternalFileGrant) -> HostResult<()> {
        let mut inner = self.lock();
        if let Some(existing) = inner.grants.get(&grant.public.id) {
            if existing != &grant {
                return Err(HostError::invalid("Conflicting file handle registration"));
            }
            return Ok(());
        }
        inner.grants.insert(grant.public.id.clone(), grant.clone());
        if let Some(connection) = inner.connection.as_mut() {
            send_file_grant(connection, &grant)?;
        }
        Ok(())
    }

    pub fn release_file_grant(&self, handle_id: &str) {
        let mut inner = self.lock();
        if inner.grants.remove(handle_id).is_none() {
            return;
        }
        if let Some(connection) = inner.connection.as_mut() {
            let _ = connection.send(
                MessageType::Event,
                uuid_v7(),
                object(json!({"type": "files.released", "handleId": handle_id})),
                Duration::from_secs(30),
            );
        }
    }

    pub fn stop(&self) {
        let mut inner = self.lock();
        if inner.stopping {
            return;
        }
        inner.stopping = true;
        let pid = inner
            .connection
            .as_ref()
            .map(|connection| connection.child.id());
        self.set_status_locked(
            &mut inner,
            RuntimeState::Stopping,
            RuntimeMode::Broker,
            pid,
            None,
        );
        if let Some(mut connection) = inner.connection.take() {
            let correlation = uuid_v7();
            let receiver = connection.subscribe(correlation);
            if connection
                .send(
                    MessageType::Shutdown,
                    correlation,
                    Map::new(),
                    Duration::from_secs(20),
                )
                .is_ok()
            {
                let _ = receive_for(
                    receiver,
                    correlation,
                    MessageType::Response,
                    Duration::from_secs(20),
                );
            }
        }
        inner.grants.clear();
        self.set_status_locked(
            &mut inner,
            RuntimeState::Stopped,
            RuntimeMode::Disabled,
            None,
            None,
        );
        // `stop` is also used by the app-owned workspace lock. Once shutdown
        // is complete, a later verified unlock must be allowed to start a new
        // broker generation in this same desktop process.
        inner.stopping = false;
    }

    /// Terminate the app-owned broker without waiting for its graceful
    /// acknowledgement. Window close must feel immediate; durable runtime
    /// state is already checkpointed and the child process is never shared.
    pub fn stop_fast(&self) {
        let mut inner = self.lock();
        if let Some(mut connection) = inner.connection.take() {
            let _ = connection.child.kill();
            let _ = connection.child.wait();
        }
        inner.grants.clear();
        inner.stopping = false;
        self.set_status_locked(
            &mut inner,
            RuntimeState::Stopped,
            RuntimeMode::Disabled,
            None,
            None,
        );
    }

    fn launch_locked(&self, inner: &mut SupervisorInner) -> HostResult<u64> {
        let verified = verify_sidecar_directory(&self.sidecar_directory)?;
        std::fs::create_dir_all(&self.data_directory)
            .map_err(|_| HostError::internal("The application data directory is unavailable"))?;

        let mut secret = Zeroizing::new(vec![0_u8; 32]);
        OsRng.fill_bytes(secret.as_mut_slice());
        let secret = Arc::new(secret);
        let mut encoded_secret = Zeroizing::new(BASE64_URL_SAFE_NO_PAD.encode(secret.as_slice()));
        let mut command = Command::new(&verified.broker);
        command
            .arg("--stdio")
            .env_clear()
            .env("CUPCAKE_BROKER_AUTH", encoded_secret.as_str())
            .env("CUPCAKE_RUNTIME_PATH", &verified.runtime)
            .env("CUPCAKE_LOCAL_BASELINE_DIR", &verified.local_baseline)
            .env("CUPCAKE_DATA_DIR", &self.data_directory)
            .env("CUPCAKE_PROTOCOL_VERSION", PROTOCOL_VERSION.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        copy_system_environment(&mut command);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command
            .spawn()
            .map_err(|_| HostError::unavailable("The verified local broker could not start"))?;
        encoded_secret.zeroize();
        let job = ProcessJob::contain(&child).map_err(|_| {
            let _ = child.kill();
            HostError::unavailable("The local broker could not be process-contained")
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| HostError::internal("The broker input pipe is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HostError::internal("The broker output pipe is unavailable"))?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_drain(stderr);
        }
        let pending = Arc::new(Mutex::new(HashMap::new()));
        spawn_protocol_reader(stdout, secret.clone(), pending.clone(), self.app.clone());
        inner.generation = inner.generation.wrapping_add(1);
        let generation = inner.generation;
        let mut connection = BrokerConnection {
            child,
            writer: BufWriter::new(stdin),
            pending,
            secret,
            session_id: uuid_v7(),
            sequences: HashMap::new(),
            _job: job,
            generation,
        };
        let correlation = uuid_v7();
        let receiver = connection.subscribe(correlation);
        connection.send(
            MessageType::Handshake,
            correlation,
            object(json!({
                "product": "CUPCAKEAGI",
                "protocolVersion": PROTOCOL_VERSION,
                "pid": std::process::id()
            })),
            HANDSHAKE_TIMEOUT,
        )?;
        let response = receive_for(
            receiver,
            correlation,
            MessageType::Handshake,
            HANDSHAKE_TIMEOUT,
        )?;
        if response.get("product").and_then(Value::as_str) != Some("CUPCAKEAGI")
            || response.get("protocolVersion").and_then(Value::as_u64)
                != Some(PROTOCOL_VERSION as u64)
        {
            return Err(HostError::unavailable(
                "The local broker handshake was rejected",
            ));
        }
        for grant in inner.grants.values() {
            send_file_grant(&mut connection, grant)?;
        }
        let pid = connection.child.id();
        inner.connection = Some(connection);
        self.set_status_locked(
            inner,
            RuntimeState::Ready,
            RuntimeMode::Broker,
            Some(pid),
            None,
        );
        Ok(generation)
    }

    fn spawn_monitor(self: &Arc<Self>, generation: u64) {
        let supervisor = Arc::downgrade(self);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            let Some(supervisor) = supervisor.upgrade() else {
                return;
            };
            let restart_delay = {
                let mut inner = supervisor.lock();
                if inner.stopping || inner.generation != generation {
                    return;
                }
                let exited = inner
                    .connection
                    .as_mut()
                    .and_then(|connection| connection.child.try_wait().ok().flatten())
                    .is_some();
                if !exited {
                    continue;
                }
                inner.connection.take();
                if inner.restart_count >= MAX_RESTARTS {
                    supervisor.set_status_locked(
                        &mut inner,
                        RuntimeState::Crashed,
                        RuntimeMode::Disabled,
                        None,
                        Some("The local broker exhausted its restart budget".into()),
                    );
                    return;
                }
                inner.restart_count += 1;
                let delay = Duration::from_millis(500 * 2_u64.pow(inner.restart_count - 1));
                supervisor.set_status_locked(
                    &mut inner,
                    RuntimeState::Crashed,
                    RuntimeMode::Broker,
                    None,
                    Some("The local broker exited and will be restarted".into()),
                );
                delay
            };
            thread::sleep(restart_delay);
            let _ = supervisor.start();
            return;
        });
    }

    fn set_status_locked(
        &self,
        inner: &mut SupervisorInner,
        state: RuntimeState,
        mode: RuntimeMode,
        pid: Option<u32>,
        detail: Option<String>,
    ) {
        inner.status = RuntimeStatus {
            state,
            mode,
            pid,
            restart_count: inner.restart_count,
            detail,
        };
        let _ = self
            .app
            .emit(RUNTIME_STATUS_EVENT_NAME, inner.status.clone());
    }

    fn lock(&self) -> MutexGuard<'_, SupervisorInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn kill_generation(&self, generation: u64) {
        let mut inner = self.lock();
        if let Some(connection) = inner
            .connection
            .as_mut()
            .filter(|connection| connection.generation == generation)
        {
            let _ = connection.child.kill();
        }
    }
}

fn spawn_protocol_reader(
    stdout: std::process::ChildStdout,
    secret: Arc<Zeroizing<Vec<u8>>>,
    pending: PendingResponses,
    app: AppHandle,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut replay = ReplayGuard::default();
        loop {
            let result = (|| {
                let envelope: ProtocolEnvelope =
                    read_protocol_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES).map_err(|_| ())?;
                envelope.verify_auth(secret.as_slice()).map_err(|_| ())?;
                replay.accept(&envelope, Utc::now()).map_err(|_| ())?;
                Ok(envelope)
            })();
            match result {
                Ok(envelope) => {
                    if envelope.message_type == MessageType::Event {
                        emit_runtime_event(&app, &envelope);
                    } else if let Some(sender) =
                        lock_pending(&pending).remove(&envelope.correlation_id)
                    {
                        let _ = sender.send(envelope);
                    }
                }
                Err(()) => {
                    lock_pending(&pending).clear();
                    return;
                }
            }
        }
    });
}

fn receive_for(
    receiver: Receiver<ProtocolEnvelope>,
    correlation_id: Uuid,
    expected: MessageType,
    timeout: Duration,
) -> HostResult<Map<String, Value>> {
    let deadline = Instant::now() + timeout;
    let remaining = deadline.saturating_duration_since(Instant::now());
    match receiver.recv_timeout(remaining) {
        Ok(envelope)
            if envelope.correlation_id == correlation_id && envelope.message_type == expected =>
        {
            Ok(envelope.payload)
        }
        Ok(_) => Err(HostError::unavailable(
            "The local broker returned an unexpected response",
        )),
        Err(RecvTimeoutError::Timeout) => Err(HostError::new(
            "RUNTIME_TIMEOUT",
            "The local runtime exceeded its deadline",
            true,
        )),
        Err(RecvTimeoutError::Disconnected) => Err(HostError::unavailable(
            "The authenticated broker connection was interrupted",
        )),
    }
}

fn lock_pending(
    pending: &PendingResponses,
) -> MutexGuard<'_, HashMap<Uuid, Sender<ProtocolEnvelope>>> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn spawn_stderr_drain(mut stderr: std::process::ChildStderr) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4 * 1024];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buffer[..count]);
                    eprintln!("[broker] {}", redact_diagnostic(&text));
                }
            }
        }
    });
}

fn redact_diagnostic(input: &str) -> String {
    let trimmed: String = input
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(2_048)
        .collect();
    match serde_json::from_str::<Value>(&trimmed) {
        Ok(value) => cupcake_tool_broker::audit::redact(value).to_string(),
        Err(_) => "broker emitted a non-structured diagnostic".into(),
    }
}

fn copy_system_environment(command: &mut Command) {
    for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // Keep the broker isolated from user-controlled PATH entries while still
    // allowing hardware probes such as Windows' signed nvidia-smi.exe to be
    // discovered from the operating-system directory.
    if let Some(system_root) = std::env::var_os("SYSTEMROOT") {
        command.env(
            "PATH",
            std::path::PathBuf::from(system_root).join("System32"),
        );
    }
    // Do not trust an ambient PATHEXT: WSL-launched Windows processes can
    // inherit a truncated value. Keep executable discovery deterministic.
    command.env("PATHEXT", ".COM;.EXE;.BAT;.CMD");
}

fn send_file_grant(connection: &mut BrokerConnection, grant: &InternalFileGrant) -> HostResult<()> {
    connection.send(
        MessageType::Event,
        uuid_v7(),
        object(json!({
            "type": "files.granted",
            "handle": {
                "id": grant.public.id,
                "kind": grant.public.kind,
                "name": grant.public.name,
                "absolutePath": grant.absolute_path,
                "writable": grant.public.writable
            }
        })),
        Duration::from_secs(30),
    )
}

fn emit_runtime_event(app: &AppHandle, envelope: &ProtocolEnvelope) {
    let event_type = envelope
        .payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("runtime.event")
        .to_owned();
    let event = RuntimeEvent {
        sequence: envelope.sequence,
        event_type,
        payload: envelope
            .payload
            .get("payload")
            .cloned()
            .unwrap_or(Value::Null),
        timestamp: envelope
            .payload
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
    };
    let _ = app.emit(RUNTIME_EVENT_NAME, event);
}

fn normalize_response(payload: Map<String, Value>) -> RuntimeResponse {
    serde_json::from_value(Value::Object(payload)).unwrap_or_else(|_| {
        RuntimeResponse::failure(
            "INVALID_RUNTIME_RESPONSE",
            "The local runtime returned an invalid response",
            false,
        )
    })
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn broker_inherits_local_app_data_for_the_dpapi_vault() {
        let expected =
            std::env::var_os("LOCALAPPDATA").expect("Windows desktop tests require LOCALAPPDATA");
        let mut command = Command::new("cupcake-tool-broker.exe");

        copy_system_environment(&mut command);

        let actual = command
            .get_envs()
            .find_map(|(name, value)| (name == "LOCALAPPDATA").then_some(value))
            .flatten();
        assert_eq!(actual, Some(expected.as_os_str()));
    }

    #[test]
    fn stderr_redaction_never_echoes_plain_text_or_secret_json_fields() {
        assert_eq!(
            redact_diagnostic("api-key=super-secret"),
            "broker emitted a non-structured diagnostic"
        );
        let redacted = redact_diagnostic(r#"{"apiKey":"super-secret","message":"failed"}"#);
        assert!(!redacted.contains("super-secret"));
        assert!(redacted.contains("failed"));
    }

    #[test]
    fn runtime_response_rejects_untyped_payloads() {
        assert_eq!(
            normalize_response(object(json!({"answer": 42})))
                .error
                .unwrap()
                .code,
            "INVALID_RUNTIME_RESPONSE"
        );
    }

    #[test]
    fn secrets_are_zeroized_by_container() {
        let mut secret = Zeroizing::new(vec![7_u8; 32]);
        secret.zeroize();
        assert!(secret.iter().all(|byte| *byte == 0));
    }
}
