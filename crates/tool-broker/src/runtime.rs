//! Supervision and authenticated proxying for the packaged Python runtime.

use crate::framing::{read_protocol_frame, write_protocol_frame, DEFAULT_MAX_FRAME_BYTES};
use crate::protocol::{uuid_v7, MessageType, ProtocolEnvelope, ProtocolLineage, ReplayGuard};
use crate::vault::{select_platform_vault, SecretBytes};
use crate::{BrokerError, Result, PROTOCOL_VERSION};
use base64::prelude::*;
use chrono::{SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub struct RuntimeChild {
    child: Child,
    input: BufReader<ChildStdout>,
    control: RuntimeControl,
    secret: Arc<Vec<u8>>,
    replay: ReplayGuard,
}

#[derive(Clone)]
pub struct RuntimeControl {
    output: Arc<Mutex<BufWriter<ChildStdin>>>,
    secret: Arc<Vec<u8>>,
    session_id: Uuid,
    sequences: Arc<Mutex<HashMap<Uuid, u64>>>,
}

impl RuntimeChild {
    /// Start the fixed packaged runtime declared by the Tauri host. Absence is a
    /// supported developer state; malformed or unlaunchable declarations fail.
    pub fn launch_from_environment() -> Result<Option<Self>> {
        let Some(path) = std::env::var_os("CUPCAKE_RUNTIME_PATH") else {
            return Ok(None);
        };
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(BrokerError::InvalidConfig(
                "CUPCAKE_RUNTIME_PATH is not a packaged file".into(),
            ));
        }
        let data_dir = std::env::var_os("CUPCAKE_DATA_DIR")
            .map(PathBuf::from)
            .ok_or_else(|| BrokerError::InvalidConfig("CUPCAKE_DATA_DIR is required".into()))?;
        std::fs::create_dir_all(&data_dir)?;
        Self::launch(&path, &data_dir).map(Some)
    }

    pub fn launch(executable: &Path, data_dir: &Path) -> Result<Self> {
        let mut secret = vec![0_u8; 32];
        OsRng.fill_bytes(&mut secret);
        let (profile_key, persistent) = profile_key()?;

        let mut command = Command::new(executable);
        command
            .arg("--stdio")
            .env_clear()
            .env(
                "CUPCAKE_RUNTIME_AUTH",
                BASE64_URL_SAFE_NO_PAD.encode(&secret),
            )
            .env(
                "CUPCAKE_PROFILE_KEY",
                BASE64_URL_SAFE_NO_PAD.encode(profile_key.expose()),
            )
            .env("CUPCAKE_DATA_DIR", data_dir)
            .env("CUPCAKE_PROTOCOL_VERSION", PROTOCOL_VERSION.to_string())
            .env(
                "CUPCAKE_REQUIRE_SQLCIPHER",
                if persistent { "1" } else { "0" },
            )
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // PyInstaller's one-file launcher and platform TLS/runtime libraries
        // require these operating-system paths. No user credentials or shell
        // configuration are inherited.
        for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("PATHEXT", ".COM;.EXE;.BAT;.CMD");
        // The signed, no-weights Cupcake Local baseline is packaged beside the
        // broker. Only the Python child receives this native path.
        let declared_baseline = std::env::var_os("CUPCAKE_LOCAL_BASELINE_DIR")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_dir())
            .and_then(|path| path.canonicalize().ok());
        let sibling_baseline = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.join("cupcake-local")))
            .filter(|path| path.is_dir())
            .and_then(|path| path.canonicalize().ok());
        if let Some(baseline) = declared_baseline.or(sibling_baseline) {
            command.env("CUPCAKE_LOCAL_BASELINE_DIR", baseline);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn()?;
        let output = child
            .stdin
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("runtime stdin unavailable".into()))?;
        let input = child
            .stdout
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("runtime stdout unavailable".into()))?;
        let secret = Arc::new(secret);
        let session_id = uuid_v7();
        let control = RuntimeControl {
            output: Arc::new(Mutex::new(BufWriter::new(output))),
            secret: secret.clone(),
            session_id,
            sequences: Arc::new(Mutex::new(HashMap::new())),
        };
        let mut runtime = Self {
            child,
            input: BufReader::new(input),
            secret,
            control,
            replay: ReplayGuard::default(),
        };
        runtime.handshake()?;
        Ok(runtime)
    }

    pub fn request(
        &mut self,
        payload: &Map<String, Value>,
    ) -> Result<Vec<(MessageType, Map<String, Value>)>> {
        let correlation = uuid_v7();
        self.send(MessageType::Request, correlation, payload.clone())?;
        self.receive_until_response(correlation)
    }

    /// Proxy a runtime request without buffering its stream. Each authenticated
    /// event is yielded as soon as it is read from the private runtime pipe;
    /// only the terminal response is returned. The caller is responsible for
    /// re-enveloping events under the desktop correlation ID.
    pub fn request_streaming<F>(
        &mut self,
        payload: &Map<String, Value>,
        mut on_event: F,
    ) -> Result<Map<String, Value>>
    where
        F: FnMut(Map<String, Value>) -> Result<()>,
    {
        let correlation = uuid_v7();
        self.send(MessageType::Request, correlation, payload.clone())?;
        self.receive_streaming(correlation, &mut on_event)
    }

    pub fn cancel(
        &mut self,
        payload: &Map<String, Value>,
    ) -> Result<Vec<(MessageType, Map<String, Value>)>> {
        let correlation = uuid_v7();
        self.send(MessageType::Cancel, correlation, payload.clone())?;
        self.receive_until_response(correlation)
    }

    pub fn control(&self) -> RuntimeControl {
        self.control.clone()
    }

    pub fn shutdown(&mut self) {
        let correlation = uuid_v7();
        let _ = self.send(MessageType::Shutdown, correlation, Map::new());
        let _ = self.receive_until_response(correlation);
        let _ = self.child.wait();
    }

    fn handshake(&mut self) -> Result<()> {
        let correlation = uuid_v7();
        let payload = json!({
            "product": "CUPCAKEAGI",
            "protocolVersion": PROTOCOL_VERSION,
            "brokerPid": std::process::id()
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        if let Err(error) =
            self.control
                .send_with_deadline(MessageType::Handshake, correlation, payload, 180)
        {
            eprintln!("[broker] runtime handshake send failed: {error}");
            return Err(error);
        }
        let messages = match self.receive_until(correlation, MessageType::Handshake) {
            Ok(messages) => messages,
            Err(error) => {
                eprintln!("[broker] runtime handshake receive failed: {error}");
                return Err(error);
            }
        };
        let response = messages.last().map(|(_, payload)| payload).ok_or_else(|| {
            BrokerError::InvalidEnvelope("runtime handshake response missing".into())
        })?;
        if response.get("product").and_then(Value::as_str) != Some("CUPCAKEAGI")
            || response.get("protocolVersion").and_then(Value::as_u64)
                != Some(PROTOCOL_VERSION as u64)
        {
            return Err(BrokerError::InvalidEnvelope(
                "runtime handshake response is invalid".into(),
            ));
        }
        Ok(())
    }

    fn receive_until_response(
        &mut self,
        correlation: Uuid,
    ) -> Result<Vec<(MessageType, Map<String, Value>)>> {
        self.receive_until(correlation, MessageType::Response)
    }

    fn receive_streaming<F>(
        &mut self,
        correlation: Uuid,
        on_event: &mut F,
    ) -> Result<Map<String, Value>>
    where
        F: FnMut(Map<String, Value>) -> Result<()>,
    {
        loop {
            let envelope: ProtocolEnvelope =
                read_protocol_frame(&mut self.input, DEFAULT_MAX_FRAME_BYTES)?;
            envelope.verify_auth(self.secret.as_slice())?;
            self.replay.accept(&envelope, Utc::now())?;
            if envelope.correlation_id != correlation {
                if envelope.message_type == MessageType::Response {
                    // A fire-and-forget cancellation acknowledgement may share
                    // the pipe while another request is streaming.
                    continue;
                }
                return Err(BrokerError::InvalidEnvelope(
                    "runtime returned an unexpected correlation id".into(),
                ));
            }
            match envelope.message_type {
                MessageType::Event => on_event(envelope.payload)?,
                MessageType::Response => return Ok(envelope.payload),
                _ => {
                    return Err(BrokerError::InvalidEnvelope(
                        "runtime returned an unexpected message type".into(),
                    ))
                }
            }
        }
    }

    fn receive_until(
        &mut self,
        correlation: Uuid,
        terminal: MessageType,
    ) -> Result<Vec<(MessageType, Map<String, Value>)>> {
        let mut messages = Vec::new();
        loop {
            let envelope: ProtocolEnvelope =
                read_protocol_frame(&mut self.input, DEFAULT_MAX_FRAME_BYTES)?;
            envelope.verify_auth(self.secret.as_slice())?;
            self.replay.accept(&envelope, Utc::now())?;
            if envelope.correlation_id != correlation {
                return Err(BrokerError::InvalidEnvelope(
                    "runtime returned an unexpected correlation id".into(),
                ));
            }
            let kind = envelope.message_type;
            messages.push((kind, envelope.payload));
            if kind == terminal {
                return Ok(messages);
            }
            if kind != MessageType::Event {
                return Err(BrokerError::InvalidEnvelope(
                    "runtime returned an unexpected message type".into(),
                ));
            }
        }
    }

    fn send(
        &mut self,
        message_type: MessageType,
        correlation: Uuid,
        payload: Map<String, Value>,
    ) -> Result<()> {
        self.control.send(message_type, correlation, payload)
    }
}

impl RuntimeControl {
    pub fn signal_cancel(&self, payload: Map<String, Value>) -> Result<()> {
        self.send(MessageType::Cancel, uuid_v7(), payload)
    }

    fn send(
        &self,
        message_type: MessageType,
        correlation: Uuid,
        payload: Map<String, Value>,
    ) -> Result<()> {
        self.send_with_deadline(message_type, correlation, payload, 30)
    }

    fn send_with_deadline(
        &self,
        message_type: MessageType,
        correlation: Uuid,
        payload: Map<String, Value>,
        deadline_seconds: i64,
    ) -> Result<()> {
        let sequence = {
            let mut sequences = self
                .sequences
                .lock()
                .map_err(|_| BrokerError::InvalidConfig("runtime sequence lock failed".into()))?;
            let sequence = sequences
                .entry(correlation)
                .and_modify(|value| *value += 1)
                .or_insert(1);
            *sequence
        };
        let envelope = ProtocolEnvelope::unsigned(
            uuid_v7(),
            correlation,
            self.session_id,
            sequence,
            (Utc::now() + chrono::Duration::seconds(deadline_seconds))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            ProtocolLineage::default(),
            message_type,
            payload,
        )
        .sign(self.secret.as_slice())?;
        let mut output = self
            .output
            .lock()
            .map_err(|_| BrokerError::InvalidConfig("runtime output lock failed".into()))?;
        write_protocol_frame(&mut *output, &envelope, DEFAULT_MAX_FRAME_BYTES)
    }
}

impl Drop for RuntimeChild {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn profile_key() -> Result<(SecretBytes, bool)> {
    const ACCOUNT: &str = "profile.default.master-key";
    let selected = select_platform_vault();
    if let Some(key) = selected.inner().load(ACCOUNT)? {
        if key.expose().len() != 32 {
            return Err(BrokerError::Integrity(
                "stored profile key has an invalid length".into(),
            ));
        }
        return Ok((key, selected.inner().is_persistent()));
    }
    let mut bytes = vec![0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let key = SecretBytes::new(bytes)?;
    selected.inner().store(ACCOUNT, &key)?;
    Ok((key, selected.inner().is_persistent()))
}
