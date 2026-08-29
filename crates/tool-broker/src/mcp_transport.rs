//! Out-of-process MCP transports owned by the privileged broker.
//!
//! Local servers speak MCP's newline-delimited JSON-RPC over private stdio.
//! Remote servers speak the 2025-11-25 Streamable HTTP transport through a
//! redirect-free, DNS-pinned client. Every connection owns an independent
//! protocol session and schema allowlist.

use crate::mcp::{
    ConnectionState, McpConnection, McpToolSchema, McpTransportConfig, OAuthPkceConfig,
};
#[cfg(windows)]
use crate::registry::ResourceLimits;
use crate::vault::{select_platform_vault, CredentialVault, SecretBytes};
use crate::{BrokerError, Result};
use base64::prelude::*;
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

#[cfg(windows)]
use crate::process_containment::{assign_and_resume, CREATE_SUSPENDED_FLAG};
#[cfg(windows)]
use crate::sandbox::WindowsJob;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SESSION_ID_BYTES: usize = 1024;
const CLIENT_ORIGIN: &str = "https://desktop.cupcakeagi.local";

#[derive(Debug, Clone)]
pub struct McpTransportLimits {
    pub request_timeout: Duration,
    pub max_message_bytes: usize,
    pub max_response_bytes: usize,
}

impl Default for McpTransportLimits {
    fn default() -> Self {
        Self {
            request_timeout: DEFAULT_TIMEOUT,
            max_message_bytes: MAX_LINE_BYTES,
            max_response_bytes: MAX_RESPONSE_BYTES,
        }
    }
}

impl McpTransportLimits {
    fn validate(&self) -> Result<()> {
        if self.request_timeout.is_zero()
            || self.request_timeout > Duration::from_secs(15 * 60)
            || !(1024..=64 * 1024 * 1024).contains(&self.max_message_bytes)
            || self.max_response_bytes < self.max_message_bytes
            || self.max_response_bytes > 128 * 1024 * 1024
        {
            return Err(BrokerError::InvalidConfig(
                "invalid MCP timeout or output limits".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct McpConnectionSnapshot {
    pub id: String,
    pub state: ConnectionState,
    pub schema_digest: Option<String>,
    pub pending_schema_digest: Option<String>,
    pub tools: Vec<McpToolSchema>,
}

#[derive(Debug, Clone)]
pub struct OAuthAuthorizationRequest {
    pub authorization_url: Url,
    pub state: String,
}

/// Narrow synchronous API used by the broker dispatch layer. Calls are
/// serialized per MCP session, while separate MCP connections remain isolated.
pub struct McpTransportService {
    sessions: Mutex<HashMap<String, Arc<Mutex<ManagedSession>>>>,
    cancellations: Mutex<HashMap<String, McpCancellationHandle>>,
    vault: Arc<dyn CredentialVault>,
    limits: McpTransportLimits,
}

impl McpTransportService {
    pub fn platform(limits: McpTransportLimits) -> Result<Self> {
        let vault: Arc<dyn CredentialVault> = Arc::from(select_platform_vault().into_inner());
        Self::new(vault, limits)
    }

    pub fn new(vault: Arc<dyn CredentialVault>, limits: McpTransportLimits) -> Result<Self> {
        limits.validate()?;
        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            vault,
            limits,
        })
    }

    /// Registers configuration without performing network or process I/O.
    /// This permits an OAuth authorization flow before initialization.
    pub fn register(&self, id: &str, config: McpTransportConfig) -> Result<()> {
        self.register_with_schema_digest(id, config, None)
    }

    /// Restores a broker-persisted approved schema digest without restoring
    /// any tool permission. A changed live schema enters approval-required
    /// state before a single tool can be called.
    pub fn register_with_schema_digest(
        &self,
        id: &str,
        config: McpTransportConfig,
        approved_schema_digest: Option<&str>,
    ) -> Result<()> {
        let mut connection = McpConnection::new(id, config.clone())?;
        if let Some(digest) = approved_schema_digest {
            connection.restore_approved_schema_digest(digest)?;
        }
        let transport = match &config {
            McpTransportConfig::Stdio { .. } => ManagedTransport::PendingStdio,
            McpTransportConfig::StreamableHttp {
                endpoint, oauth, ..
            } => {
                validate_remote_url(endpoint)?;
                if let Some(oauth) = oauth {
                    validate_remote_url(&oauth.authorization_endpoint)?;
                    validate_remote_url(&oauth.token_endpoint)?;
                }
                ManagedTransport::PendingRemote(RemotePending {
                    endpoint: endpoint.clone(),
                    oauth: oauth.as_deref().cloned(),
                    authorization: None,
                })
            }
        };
        let mut sessions = self.sessions.lock().expect("MCP sessions lock poisoned");
        if sessions.contains_key(id) {
            return Err(BrokerError::Duplicate(id.into()));
        }
        sessions.insert(
            id.into(),
            Arc::new(Mutex::new(ManagedSession {
                connection,
                transport,
            })),
        );
        Ok(())
    }

    pub fn connect(&self, id: &str) -> Result<McpConnectionSnapshot> {
        let session_ref = self.session(id)?;
        let mut session = session_ref.lock().expect("MCP session lock poisoned");
        session.connection.begin_connect()?;

        let outcome = (|| {
            if matches!(session.transport, ManagedTransport::PendingStdio) {
                let stdio = StdioMcpSession::launch(&session.connection.config, &self.limits)?;
                session.transport = ManagedTransport::Stdio(stdio);
            } else if let ManagedTransport::PendingRemote(pending) = &session.transport {
                let remote =
                    RemoteMcpSession::connect(id, pending, self.vault.as_ref(), &self.limits)?;
                session.transport = ManagedTransport::Remote(remote);
            }

            let tools = match &mut session.transport {
                ManagedTransport::Stdio(transport) => transport.list_tools()?,
                ManagedTransport::Remote(transport) => transport.list_tools(self.vault.as_ref())?,
                _ => {
                    return Err(BrokerError::InvalidTransition {
                        from: "pending".into(),
                        to: "connected".into(),
                    })
                }
            };
            let cancellation = match &session.transport {
                ManagedTransport::Stdio(transport) => transport.cancellation_handle(),
                ManagedTransport::Remote(transport) => transport.cancellation_handle(),
                _ => unreachable!("connected transport was checked above"),
            };
            self.cancellations
                .lock()
                .expect("MCP cancellations lock poisoned")
                .insert(id.into(), cancellation);
            session.connection.receive_schema(tools)?;
            Ok(snapshot(&session))
        })();

        if outcome.is_err() {
            self.cancellations
                .lock()
                .expect("MCP cancellations lock poisoned")
                .remove(id);
            let _ = session.connection.connection_failed();
        }
        outcome
    }

    pub fn snapshot(&self, id: &str) -> Result<McpConnectionSnapshot> {
        let session = self.session(id)?;
        let session = session.lock().expect("MCP session lock poisoned");
        Ok(snapshot(&session))
    }

    pub fn approve_schema(&self, id: &str, digest: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut session = session.lock().expect("MCP session lock poisoned");
        session.connection.approve_pending_schema(digest)
    }

    pub fn allow_tool(&self, id: &str, tool_id: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut session = session.lock().expect("MCP session lock poisoned");
        session.connection.allow_tool(tool_id)
    }

    pub fn call_tool(&self, id: &str, tool_id: &str, arguments: Value) -> Result<Value> {
        let session = self.session(id)?;
        let mut session = session.lock().expect("MCP session lock poisoned");
        session.connection.authorize_call(tool_id)?;
        match &mut session.transport {
            ManagedTransport::Stdio(transport) => transport.call_tool(tool_id, arguments),
            ManagedTransport::Remote(transport) => {
                transport.call_tool(tool_id, arguments, self.vault.as_ref())
            }
            _ => Err(BrokerError::InvalidTransition {
                from: "disconnected".into(),
                to: "tool call".into(),
            }),
        }
    }

    /// Durable-task variant where the caller owns the JSON-RPC request ID and
    /// can therefore cancel that exact in-flight operation.
    pub fn call_tool_with_request_id(
        &self,
        id: &str,
        request_id: u64,
        tool_id: &str,
        arguments: Value,
    ) -> Result<Value> {
        if request_id == 0 {
            return Err(BrokerError::InvalidConfig(
                "MCP request ID must be non-zero".into(),
            ));
        }
        let session = self.session(id)?;
        let mut session = session.lock().expect("MCP session lock poisoned");
        session.connection.authorize_call(tool_id)?;
        match &mut session.transport {
            ManagedTransport::Stdio(transport) => {
                transport.call_tool_with_id(request_id, tool_id, arguments)
            }
            ManagedTransport::Remote(transport) => {
                transport.call_tool_with_id(request_id, tool_id, arguments, self.vault.as_ref())
            }
            _ => Err(BrokerError::InvalidTransition {
                from: "disconnected".into(),
                to: "tool call".into(),
            }),
        }
    }

    pub fn cancel(&self, id: &str, request_id: u64, reason: &str) -> Result<()> {
        let cancellation = self
            .cancellations
            .lock()
            .expect("MCP cancellations lock poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| BrokerError::InvalidTransition {
                from: "disconnected".into(),
                to: "cancel".into(),
            })?;
        cancellation.cancel(request_id, reason, self.vault.as_ref())
    }

    pub fn begin_oauth(&self, id: &str) -> Result<OAuthAuthorizationRequest> {
        let session = self.session(id)?;
        let mut session = session.lock().expect("MCP session lock poisoned");
        let pending = match &mut session.transport {
            ManagedTransport::PendingRemote(pending) => pending,
            _ => {
                return Err(BrokerError::InvalidTransition {
                    from: "not a pending remote connection".into(),
                    to: "OAuth authorization".into(),
                })
            }
        };
        pending.begin_oauth()
    }

    /// Verifies the exact loopback callback and state before exchanging the
    /// code. Refresh/access tokens are stored only in the platform vault.
    pub fn complete_oauth(&self, id: &str, callback: &Url) -> Result<()> {
        let session = self.session(id)?;
        let mut session = session.lock().expect("MCP session lock poisoned");
        let pending = match &mut session.transport {
            ManagedTransport::PendingRemote(pending) => pending,
            _ => {
                return Err(BrokerError::InvalidTransition {
                    from: "not a pending remote connection".into(),
                    to: "OAuth callback".into(),
                })
            }
        };
        pending.complete_oauth(id, callback, self.vault.as_ref(), &self.limits)
    }

    pub fn disconnect(&self, id: &str) -> Result<()> {
        self.cancellations
            .lock()
            .expect("MCP cancellations lock poisoned")
            .remove(id);
        let mut sessions = self.sessions.lock().expect("MCP sessions lock poisoned");
        let session = sessions
            .remove(id)
            .ok_or_else(|| BrokerError::NotFound(id.into()))?;
        drop(sessions);
        let mut session = session.lock().expect("MCP session lock poisoned");
        match &mut session.transport {
            ManagedTransport::Stdio(transport) => transport.shutdown(),
            ManagedTransport::Remote(transport) => transport.shutdown(self.vault.as_ref()),
            _ => Ok(()),
        }
    }

    fn session(&self, id: &str) -> Result<Arc<Mutex<ManagedSession>>> {
        self.sessions
            .lock()
            .expect("MCP sessions lock poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| BrokerError::NotFound(id.into()))
    }
}

fn snapshot(session: &ManagedSession) -> McpConnectionSnapshot {
    McpConnectionSnapshot {
        id: session.connection.id.clone(),
        state: session.connection.state(),
        schema_digest: session.connection.schema_digest().map(str::to_owned),
        pending_schema_digest: session
            .connection
            .pending_schema_digest()
            .map(str::to_owned),
        tools: session.connection.tools(),
    }
}

struct ManagedSession {
    connection: McpConnection,
    transport: ManagedTransport,
}

enum ManagedTransport {
    PendingStdio,
    PendingRemote(RemotePending),
    Stdio(StdioMcpSession),
    Remote(RemoteMcpSession),
}

#[derive(Clone)]
enum McpCancellationHandle {
    Stdio {
        writer: Arc<Mutex<BufWriter<ChildStdin>>>,
        child: Arc<Mutex<Child>>,
        #[cfg(windows)]
        job: Arc<WindowsJob>,
        maximum: usize,
    },
    Remote {
        id: String,
        endpoint: Url,
        client: Client,
        session_id: Arc<Mutex<Option<String>>>,
        oauth: bool,
    },
}

impl McpCancellationHandle {
    fn cancel(&self, request_id: u64, reason: &str, vault: &dyn CredentialVault) -> Result<()> {
        if reason.len() > 1024 {
            return Err(BrokerError::InvalidConfig(
                "cancel reason is too long".into(),
            ));
        }
        let value = json!({
            "jsonrpc":"2.0",
            "method":"notifications/cancelled",
            "params":{"requestId":request_id, "reason":reason}
        });
        match self {
            Self::Stdio {
                writer,
                child,
                #[cfg(windows)]
                job,
                maximum,
            } => {
                let bytes = serde_json::to_vec(&value)?;
                if bytes.len() > *maximum {
                    return Err(BrokerError::FrameTooLarge {
                        actual: bytes.len(),
                        maximum: *maximum,
                    });
                }
                let mut writer = writer.lock().expect("MCP writer lock poisoned");
                writer.write_all(&bytes)?;
                writer.write_all(b"\n")?;
                writer.flush()?;
                drop(writer);
                #[cfg(windows)]
                let _ = job.terminate(0xC0C0_0005);
                if let Ok(mut child) = child.lock() {
                    if child.try_wait().ok().flatten().is_none() {
                        let _ = child.kill();
                    }
                }
                Ok(())
            }
            Self::Remote {
                id,
                endpoint,
                client,
                session_id,
                oauth,
            } => {
                let mut request = client
                    .post(endpoint.clone())
                    .header(ORIGIN, CLIENT_ORIGIN)
                    .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
                    .header(ACCEPT, "application/json, text/event-stream")
                    .json(&value);
                if let Some(session) = session_id
                    .lock()
                    .expect("MCP session ID lock poisoned")
                    .clone()
                {
                    request = request.header("MCP-Session-Id", session);
                }
                if *oauth {
                    let token = load_token(vault, id)?.ok_or_else(|| {
                        BrokerError::PermissionDenied(
                            "remote MCP cancellation has no OAuth token".into(),
                        )
                    })?;
                    request = request.bearer_auth(token.access_token);
                }
                let response = request.send().map_err(http_error)?;
                validate_final_response(&response, endpoint)?;
                if response.status().is_success() || response.status() == StatusCode::ACCEPTED {
                    Ok(())
                } else {
                    Err(BrokerError::InvalidEnvelope(format!(
                        "remote MCP cancellation returned HTTP {}",
                        response.status()
                    )))
                }
            }
        }
    }
}

struct StdioMcpSession {
    child: Arc<Mutex<Child>>,
    #[cfg(windows)]
    job: Arc<WindowsJob>,
    writer: Arc<Mutex<BufWriter<ChildStdin>>>,
    responses: Mutex<mpsc::Receiver<std::result::Result<Value, String>>>,
    request_lock: Mutex<()>,
    next_id: AtomicU64,
    limits: McpTransportLimits,
}

impl StdioMcpSession {
    fn launch(config: &McpTransportConfig, limits: &McpTransportLimits) -> Result<Self> {
        let McpTransportConfig::Stdio {
            executable,
            arguments,
            inherited_environment,
        } = config
        else {
            return Err(BrokerError::InvalidConfig(
                "expected stdio MCP config".into(),
            ));
        };
        let mut command = Command::new(executable);
        command.args(arguments).env_clear();
        for name in inherited_environment {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        inherit_windows_runtime_environment(&mut command);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000 | CREATE_SUSPENDED_FLAG); // CREATE_NO_WINDOW
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = assign_and_resume(
            &mut child,
            &ResourceLimits {
                timeout_ms: limits.request_timeout.as_millis().min(u64::MAX as u128) as u64,
                max_output_bytes: limits.max_response_bytes,
                max_memory_bytes: Some(1024 * 1024 * 1024),
                max_cpu_seconds: None,
            },
            32,
        )?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("MCP stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("MCP stdout unavailable".into()))?;
        let (tx, rx) = mpsc::sync_channel(32);
        let maximum = limits.max_message_bytes;
        thread::Builder::new()
            .name("cupcake-mcp-stdio-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let result =
                        read_json_line(&mut reader, maximum).map_err(|error| error.to_string());
                    let terminal = result.is_err();
                    if tx.send(result).is_err() || terminal {
                        break;
                    }
                }
            })?;
        let session = Self {
            child: Arc::new(Mutex::new(child)),
            #[cfg(windows)]
            job,
            writer: Arc::new(Mutex::new(BufWriter::new(stdin))),
            responses: Mutex::new(rx),
            request_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            limits: limits.clone(),
        };
        session.initialize()?;
        Ok(session)
    }

    fn initialize(&self) -> Result<()> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "CUPCAKEAGI", "version": env!("CARGO_PKG_VERSION")}
            }),
        )?;
        self.notify("notifications/initialized", json!({}))
    }

    fn cancellation_handle(&self) -> McpCancellationHandle {
        McpCancellationHandle::Stdio {
            writer: Arc::clone(&self.writer),
            child: Arc::clone(&self.child),
            #[cfg(windows)]
            job: Arc::clone(&self.job),
            maximum: self.limits.max_message_bytes,
        }
    }

    fn list_tools(&self) -> Result<Vec<McpToolSchema>> {
        tools_from_result(self.request("tools/list", json!({}))?)
    }

    fn call_tool(&self, tool_id: &str, arguments: Value) -> Result<Value> {
        self.request(
            "tools/call",
            json!({"name": tool_id, "arguments": arguments}),
        )
    }

    fn call_tool_with_id(&self, id: u64, tool_id: &str, arguments: Value) -> Result<Value> {
        self.request_with_id(
            id,
            "tools/call",
            json!({"name": tool_id, "arguments": arguments}),
        )
    }

    fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.request_with_id(id, method, params)
    }

    fn request_with_id(&self, id: u64, method: &str, params: Value) -> Result<Value> {
        let _serial = self.request_lock.lock().expect("MCP request lock poisoned");
        self.write(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))?;
        let receiver = self.responses.lock().expect("MCP response lock poisoned");
        let mut consumed = 0_usize;
        loop {
            let message = match receiver.recv_timeout(self.limits.request_timeout) {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => return Err(BrokerError::InvalidEnvelope(error)),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = self.cancel(id, "request timeout");
                    self.terminate();
                    return Err(BrokerError::InvalidEnvelope("MCP request timed out".into()));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(BrokerError::InvalidEnvelope(
                        "MCP process closed its protocol stream".into(),
                    ))
                }
            };
            consumed = consumed.saturating_add(serde_json::to_vec(&message)?.len());
            if consumed > self.limits.max_response_bytes {
                self.terminate();
                return Err(BrokerError::FrameTooLarge {
                    actual: consumed,
                    maximum: self.limits.max_response_bytes,
                });
            }
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                // Server notifications are valid, but another request's reply
                // is impossible because this connection serializes requests.
                if message.get("method").is_some() && message.get("id").is_none() {
                    continue;
                }
                return Err(BrokerError::InvalidEnvelope(
                    "MCP response id does not match its request".into(),
                ));
            }
            return json_rpc_result(message);
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(json!({"jsonrpc":"2.0", "method":method, "params":params}))
    }

    fn cancel(&self, request_id: u64, reason: &str) -> Result<()> {
        if reason.len() > 1024 {
            return Err(BrokerError::InvalidConfig(
                "cancel reason is too long".into(),
            ));
        }
        self.notify(
            "notifications/cancelled",
            json!({"requestId": request_id, "reason": reason}),
        )
    }

    fn write(&self, value: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() > self.limits.max_message_bytes {
            return Err(BrokerError::FrameTooLarge {
                actual: bytes.len(),
                maximum: self.limits.max_message_bytes,
            });
        }
        let mut writer = self.writer.lock().expect("MCP writer lock poisoned");
        writer.write_all(&bytes)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<()> {
        let _ = self.request("shutdown", json!({}));
        self.terminate();
        Ok(())
    }

    fn terminate(&self) {
        #[cfg(windows)]
        let _ = self.job.terminate(0xC0C0_0003);
        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

impl Drop for StdioMcpSession {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn read_json_line<R: BufRead>(reader: &mut R, maximum: usize) -> Result<Value> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(BrokerError::TruncatedFrame);
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(take) > maximum {
            return Err(BrokerError::FrameTooLarge {
                actual: line.len().saturating_add(take),
                maximum,
            });
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if line.last() == Some(&b'\n') {
            break;
        }
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    if line.is_empty() {
        return Err(BrokerError::InvalidEnvelope("empty MCP stdio line".into()));
    }
    Ok(serde_json::from_slice(&line)?)
}

struct RemotePending {
    endpoint: Url,
    oauth: Option<OAuthPkceConfig>,
    authorization: Option<PendingAuthorization>,
}

impl RemotePending {
    fn begin_oauth(&mut self) -> Result<OAuthAuthorizationRequest> {
        let config = self.oauth.as_ref().ok_or_else(|| {
            BrokerError::InvalidConfig("MCP connection has no OAuth config".into())
        })?;
        // Refuse PKCE flows if the configured authorization host itself is not
        // public. Discovery is intentionally broker-owned and never delegated
        // to the renderer.
        resolve_public(&config.authorization_endpoint)?;
        let verifier = random_urlsafe(64);
        let challenge = BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(32);
        let mut url = config.authorization_endpoint.clone();
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &config.client_id)
                .append_pair("redirect_uri", config.redirect_uri.as_str())
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .append_pair("resource", self.endpoint.as_str())
                .append_pair(
                    "scope",
                    &config.scopes.iter().cloned().collect::<Vec<_>>().join(" "),
                );
        }
        self.authorization = Some(PendingAuthorization {
            state: state.clone(),
            verifier,
        });
        Ok(OAuthAuthorizationRequest {
            authorization_url: url,
            state,
        })
    }

    fn complete_oauth(
        &mut self,
        id: &str,
        callback: &Url,
        vault: &dyn CredentialVault,
        limits: &McpTransportLimits,
    ) -> Result<()> {
        let config = self.oauth.as_ref().ok_or_else(|| {
            BrokerError::InvalidConfig("MCP connection has no OAuth config".into())
        })?;
        validate_callback(callback, &config.redirect_uri)?;
        let pairs: Vec<_> = callback.query_pairs().into_owned().collect();
        let values = |name: &str| {
            pairs
                .iter()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>()
        };
        let states = values("state");
        let codes = values("code");
        if states.len() != 1 || codes.len() != 1 || pairs.iter().any(|(key, _)| key == "error") {
            return Err(BrokerError::InvalidEnvelope(
                "OAuth callback must contain exactly one code and state".into(),
            ));
        }
        let state = states[0];
        let code = codes[0];
        if code.len() > 8192 {
            return Err(BrokerError::InvalidEnvelope(
                "OAuth code is too long".into(),
            ));
        }
        let pending = self
            .authorization
            .take()
            .ok_or_else(|| BrokerError::InvalidTransition {
                from: "no authorization request".into(),
                to: "OAuth callback".into(),
            })?;
        if !constant_time_eq(state.as_bytes(), pending.state.as_bytes()) {
            return Err(BrokerError::Integrity("OAuth state mismatch".into()));
        }
        let client = pinned_client(&config.token_endpoint, limits.request_timeout)?;
        let response = client
            .post(config.token_endpoint.clone())
            .header(ORIGIN, CLIENT_ORIGIN)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", config.client_id.as_str()),
                ("code", code),
                ("code_verifier", pending.verifier.as_str()),
                ("redirect_uri", config.redirect_uri.as_str()),
                ("resource", self.endpoint.as_str()),
            ])
            .send()
            .map_err(http_error)?;
        let token = parse_token_response(response, limits.max_response_bytes)?;
        store_token(vault, id, &token)
    }
}

struct PendingAuthorization {
    state: String,
    verifier: String,
}

struct RemoteMcpSession {
    id: String,
    endpoint: Url,
    oauth: Option<OAuthPkceConfig>,
    client: Client,
    session_id: Arc<Mutex<Option<String>>>,
    next_id: u64,
    limits: McpTransportLimits,
}

impl RemoteMcpSession {
    fn connect(
        id: &str,
        pending: &RemotePending,
        vault: &dyn CredentialVault,
        limits: &McpTransportLimits,
    ) -> Result<Self> {
        let client = pinned_client(&pending.endpoint, limits.request_timeout)?;
        let mut session = Self {
            id: id.into(),
            endpoint: pending.endpoint.clone(),
            oauth: pending.oauth.clone(),
            client,
            session_id: Arc::new(Mutex::new(None)),
            next_id: 1,
            limits: limits.clone(),
        };
        session.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name":"CUPCAKEAGI", "version":env!("CARGO_PKG_VERSION")}
            }),
            vault,
        )?;
        session.notify("notifications/initialized", json!({}), vault)?;
        Ok(session)
    }

    fn list_tools(&mut self, vault: &dyn CredentialVault) -> Result<Vec<McpToolSchema>> {
        let result = self.request("tools/list", json!({}), vault)?;
        tools_from_result(result)
    }

    fn cancellation_handle(&self) -> McpCancellationHandle {
        McpCancellationHandle::Remote {
            id: self.id.clone(),
            endpoint: self.endpoint.clone(),
            client: self.client.clone(),
            session_id: Arc::clone(&self.session_id),
            oauth: self.oauth.is_some(),
        }
    }

    fn call_tool(
        &mut self,
        tool_id: &str,
        arguments: Value,
        vault: &dyn CredentialVault,
    ) -> Result<Value> {
        self.request(
            "tools/call",
            json!({"name":tool_id, "arguments":arguments}),
            vault,
        )
    }

    fn call_tool_with_id(
        &mut self,
        id: u64,
        tool_id: &str,
        arguments: Value,
        vault: &dyn CredentialVault,
    ) -> Result<Value> {
        self.request_with_id(
            id,
            "tools/call",
            json!({"name":tool_id, "arguments":arguments}),
            vault,
        )
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        vault: &dyn CredentialVault,
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.request_with_id(id, method, params, vault)
    }

    fn request_with_id(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        vault: &dyn CredentialVault,
    ) -> Result<Value> {
        let value = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
        let response = self.send_http(Method::POST, Some(&value), vault)?;
        let result = parse_streamable_response(response, id, self.limits.max_response_bytes)?;
        json_rpc_result(result)
    }

    fn notify(&mut self, method: &str, params: Value, vault: &dyn CredentialVault) -> Result<()> {
        let value = json!({"jsonrpc":"2.0", "method":method, "params":params});
        let response = self.send_http(Method::POST, Some(&value), vault)?;
        if !response.status().is_success() && response.status() != StatusCode::ACCEPTED {
            return Err(BrokerError::InvalidEnvelope(format!(
                "MCP notification failed with HTTP {}",
                response.status()
            )));
        }
        Ok(())
    }

    fn send_http(
        &mut self,
        method: Method,
        body: Option<&Value>,
        vault: &dyn CredentialVault,
    ) -> Result<Response> {
        let mut builder = self
            .client
            .request(method, self.endpoint.clone())
            .header(ORIGIN, CLIENT_ORIGIN)
            .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
            .header(ACCEPT, "application/json, text/event-stream");
        if let Some(session_id) = self
            .session_id
            .lock()
            .expect("MCP session ID lock poisoned")
            .clone()
        {
            builder = builder.header("MCP-Session-Id", session_id);
        }
        if let Some(body) = body {
            builder = builder.header(CONTENT_TYPE, "application/json").json(body);
        }
        if self.oauth.is_some() {
            let token = self.valid_token(vault)?;
            let value = HeaderValue::from_str(&format!("Bearer {}", token.access_token))
                .map_err(|_| BrokerError::Integrity("stored OAuth token is invalid".into()))?;
            builder = builder.header(AUTHORIZATION, value);
        }
        let response = builder.send().map_err(http_error)?;
        validate_final_response(&response, &self.endpoint)?;
        if let Some(value) = response.headers().get("MCP-Session-Id") {
            let session = value
                .to_str()
                .map_err(|_| BrokerError::InvalidEnvelope("invalid MCP session ID".into()))?;
            if session.is_empty()
                || session.len() > MAX_SESSION_ID_BYTES
                || !session.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            {
                return Err(BrokerError::InvalidEnvelope(
                    "invalid MCP session ID".into(),
                ));
            }
            *self
                .session_id
                .lock()
                .expect("MCP session ID lock poisoned") = Some(session.into());
        }
        if response.status() == StatusCode::NOT_FOUND
            && self
                .session_id
                .lock()
                .expect("MCP session ID lock poisoned")
                .is_some()
        {
            *self
                .session_id
                .lock()
                .expect("MCP session ID lock poisoned") = None;
            return Err(BrokerError::InvalidTransition {
                from: "expired remote MCP session".into(),
                to: "reconnect required".into(),
            });
        }
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(BrokerError::PermissionDenied(
                "remote MCP authorization is missing or expired".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(BrokerError::InvalidEnvelope(format!(
                "remote MCP returned HTTP {}",
                response.status()
            )));
        }
        Ok(response)
    }

    fn valid_token(&self, vault: &dyn CredentialVault) -> Result<OAuthTokenSet> {
        let mut token = load_token(vault, &self.id)?.ok_or_else(|| {
            BrokerError::PermissionDenied("remote MCP requires OAuth authorization".into())
        })?;
        if token.expires_at > unix_now().saturating_add(30) {
            return Ok(token);
        }
        let refresh = token.refresh_token.as_deref().ok_or_else(|| {
            BrokerError::PermissionDenied("MCP OAuth token expired without a refresh token".into())
        })?;
        let config = self.oauth.as_ref().ok_or_else(|| {
            BrokerError::Integrity("stored OAuth token has no connection configuration".into())
        })?;
        let client = pinned_client(&config.token_endpoint, self.limits.request_timeout)?;
        let response = client
            .post(config.token_endpoint.clone())
            .header(ORIGIN, CLIENT_ORIGIN)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", config.client_id.as_str()),
                ("refresh_token", refresh),
                ("resource", self.endpoint.as_str()),
            ])
            .send()
            .map_err(http_error)?;
        let refreshed = parse_token_response(response, self.limits.max_response_bytes)?;
        if refreshed.refresh_token.is_none() {
            token.access_token = refreshed.access_token;
            token.expires_at = refreshed.expires_at;
        } else {
            token = refreshed;
        }
        store_token(vault, &self.id, &token)?;
        Ok(token)
    }

    fn shutdown(&mut self, vault: &dyn CredentialVault) -> Result<()> {
        if self
            .session_id
            .lock()
            .expect("MCP session ID lock poisoned")
            .is_none()
        {
            return Ok(());
        }
        let response = self.send_http(Method::DELETE, None, vault);
        *self
            .session_id
            .lock()
            .expect("MCP session ID lock poisoned") = None;
        match response {
            Ok(response) if response.status() == StatusCode::METHOD_NOT_ALLOWED => Ok(()),
            Ok(_) => Ok(()),
            Err(BrokerError::InvalidEnvelope(message)) if message.contains("405") => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthTokenSet {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
    token_type: String,
}

fn default_expires_in() -> u64 {
    3600
}

fn parse_token_response(response: Response, maximum: usize) -> Result<OAuthTokenSet> {
    if !response.status().is_success() {
        return Err(BrokerError::PermissionDenied(format!(
            "OAuth token endpoint returned HTTP {}",
            response.status()
        )));
    }
    let value: OAuthTokenResponse = serde_json::from_slice(&read_bounded(response, maximum)?)?;
    if !value.token_type.eq_ignore_ascii_case("bearer")
        || value.access_token.is_empty()
        || value.access_token.len() > 64 * 1024
        || value
            .refresh_token
            .as_ref()
            .is_some_and(|token| token.len() > 64 * 1024)
    {
        return Err(BrokerError::InvalidEnvelope(
            "OAuth token response is invalid".into(),
        ));
    }
    Ok(OAuthTokenSet {
        access_token: value.access_token,
        refresh_token: value.refresh_token,
        expires_at: unix_now().saturating_add(value.expires_in.min(365 * 24 * 3600)),
    })
}

fn store_token(vault: &dyn CredentialVault, id: &str, token: &OAuthTokenSet) -> Result<()> {
    vault.store(
        &token_account(id),
        &SecretBytes::new(serde_json::to_vec(token)?)?,
    )
}

fn load_token(vault: &dyn CredentialVault, id: &str) -> Result<Option<OAuthTokenSet>> {
    vault
        .load(&token_account(id))?
        .map(|secret| serde_json::from_slice(secret.expose()).map_err(BrokerError::from))
        .transpose()
}

fn token_account(id: &str) -> String {
    format!("mcp.oauth.{id}")
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn parse_streamable_response(response: Response, id: u64, maximum: usize) -> Result<Value> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = read_bounded(response, maximum)?;
    if content_type.starts_with("application/json") {
        return Ok(serde_json::from_slice(&body)?);
    }
    if content_type.starts_with("text/event-stream") {
        return parse_sse_response(&body, id, maximum);
    }
    Err(BrokerError::InvalidEnvelope(
        "remote MCP response has an unsupported content type".into(),
    ))
}

fn parse_sse_response(body: &[u8], id: u64, maximum: usize) -> Result<Value> {
    if body.len() > maximum {
        return Err(BrokerError::FrameTooLarge {
            actual: body.len(),
            maximum,
        });
    }
    let text = std::str::from_utf8(body)
        .map_err(|_| BrokerError::InvalidEnvelope("MCP SSE is not UTF-8".into()))?;
    let mut data = String::new();
    for line in text.lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        } else if line.is_empty() && !data.is_empty() {
            let value: Value = serde_json::from_str(&data)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return Ok(value);
            }
            data.clear();
        }
    }
    Err(BrokerError::InvalidEnvelope(
        "MCP event stream ended without the matching response".into(),
    ))
}

fn read_bounded(mut response: Response, maximum: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(BrokerError::FrameTooLarge {
            actual: bytes.len(),
            maximum,
        });
    }
    Ok(bytes)
}

fn json_rpc_result(message: Value) -> Result<Value> {
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(BrokerError::InvalidEnvelope(
            "MCP response is not JSON-RPC 2.0".into(),
        ));
    }
    if let Some(error) = message.get("error") {
        return Err(BrokerError::InvalidEnvelope(format!(
            "MCP tool error: {}",
            bounded_error(error)
        )));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| BrokerError::InvalidEnvelope("MCP response has no result".into()))
}

fn bounded_error(value: &Value) -> String {
    let mut text = value.to_string();
    text.truncate(2048);
    text
}

fn tools_from_result(result: Value) -> Result<Vec<McpToolSchema>> {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| BrokerError::InvalidEnvelope("MCP tools/list has no tools".into()))?;
    if tools.len() > 4096 {
        return Err(BrokerError::InvalidEnvelope(
            "MCP server advertised too many tools".into(),
        ));
    }
    tools
        .iter()
        .map(|value| {
            let id = value
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| BrokerError::InvalidEnvelope("MCP tool has no name".into()))?;
            let input = value
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object"}));
            let output = value
                .get("outputSchema")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object"}));
            Ok(McpToolSchema {
                id: id.into(),
                description: value
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(16 * 1024)
                    .collect(),
                input_schema: input,
                output_schema: output,
            })
        })
        .collect()
}

fn validate_remote_url(url: &Url) -> Result<()> {
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(BrokerError::InvalidConfig(
            "remote MCP and OAuth endpoints require credential-free HTTPS URLs".into(),
        ));
    }
    Ok(())
}

fn pinned_client(url: &Url, timeout: Duration) -> Result<Client> {
    validate_remote_url(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| BrokerError::InvalidConfig("remote URL has no host".into()))?;
    let addresses = resolve_public(url)?;
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(http_error)
}

fn resolve_public(url: &Url) -> Result<Vec<SocketAddr>> {
    validate_remote_url(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| BrokerError::InvalidConfig("remote URL has no host".into()))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: BTreeSet<_> = (host, port).to_socket_addrs()?.collect();
    if addresses.is_empty() {
        return Err(BrokerError::InvalidConfig(
            "remote MCP host did not resolve".into(),
        ));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(BrokerError::PermissionDenied(
            "remote MCP DNS resolved to a private, loopback, or link-local address".into(),
        ));
    }
    Ok(addresses.into_iter().collect())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.octets()[0] == 0)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

fn validate_final_response(response: &Response, expected: &Url) -> Result<()> {
    if response.url().scheme() != expected.scheme()
        || response.url().host_str() != expected.host_str()
        || response.url().port_or_known_default() != expected.port_or_known_default()
    {
        return Err(BrokerError::PermissionDenied(
            "remote MCP response changed origin".into(),
        ));
    }
    Ok(())
}

fn validate_callback(callback: &Url, expected: &Url) -> Result<()> {
    if callback.scheme() != expected.scheme()
        || callback.host_str() != expected.host_str()
        || callback.port_or_known_default() != expected.port_or_known_default()
        || callback.path() != expected.path()
        || callback.fragment().is_some()
        || callback.username() != expected.username()
    {
        return Err(BrokerError::PermissionDenied(
            "OAuth callback does not match the registered redirect URI".into(),
        ));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn random_urlsafe(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    BASE64_URL_SAFE_NO_PAD.encode(value)
}

fn http_error(error: reqwest::Error) -> BrokerError {
    BrokerError::InvalidEnvelope(format!("remote MCP transport failed: {error}"))
}

fn inherit_windows_runtime_environment(command: &mut Command) {
    for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::SessionCredentialVault;
    use reqwest::header::HeaderMap;
    use std::io::Cursor;

    #[test]
    fn line_reader_enforces_limit_before_unbounded_growth() {
        let mut input = Cursor::new(b"{\"jsonrpc\":\"2.0\"}\n".to_vec());
        assert!(read_json_line(&mut input, 128).is_ok());
        let mut oversized = Cursor::new(vec![b'a'; 129]);
        assert!(matches!(
            read_json_line(&mut oversized, 128),
            Err(BrokerError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn sse_returns_only_matching_json_rpc_response() {
        let body = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notice\"}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        assert_eq!(
            parse_sse_response(body, 7, 4096).unwrap()["result"]["ok"],
            true
        );
    }

    #[test]
    fn private_and_mapped_private_addresses_are_rejected() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("169.254.1.1".parse().unwrap()));
        assert!(!is_public_ip("10.2.3.4".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(!is_public_ip("fc00::1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn remote_registration_rejects_http_even_on_loopback() {
        let service = McpTransportService::new(
            Arc::new(SessionCredentialVault::default()),
            McpTransportLimits::default(),
        )
        .unwrap();
        let config = McpTransportConfig::StreamableHttp {
            endpoint: Url::parse("http://127.0.0.1:1234/mcp").unwrap(),
            allowed_origins: ["http://127.0.0.1:1234".into()].into_iter().collect(),
            oauth: None,
        };
        assert!(service.register("private", config).is_err());
    }

    #[test]
    fn oauth_callback_requires_exact_redirect_and_state() {
        let expected = Url::parse("http://127.0.0.1:43210/callback").unwrap();
        let wrong = Url::parse("http://127.0.0.1:43211/callback?state=x&code=y").unwrap();
        assert!(validate_callback(&wrong, &expected).is_err());
        let exact = Url::parse("http://127.0.0.1:43210/callback?state=x&code=y").unwrap();
        assert!(validate_callback(&exact, &expected).is_ok());
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"evil"));
        let duplicate =
            Url::parse("http://127.0.0.1:43210/callback?state=x&state=evil&code=y").unwrap();
        let pairs: Vec<_> = duplicate.query_pairs().into_owned().collect();
        assert_eq!(pairs.iter().filter(|(key, _)| key == "state").count(), 2);
    }

    #[test]
    fn token_vault_round_trip_keeps_refresh_material_out_of_session_state() {
        let vault = SessionCredentialVault::default();
        let token = OAuthTokenSet {
            access_token: "access".into(),
            refresh_token: Some("rotate-me".into()),
            expires_at: 123,
        };
        store_token(&vault, "demo", &token).unwrap();
        let loaded = load_token(&vault, "demo").unwrap().unwrap();
        assert_eq!(loaded.refresh_token.as_deref(), Some("rotate-me"));
    }

    #[test]
    fn schema_parser_applies_bounded_defaults() {
        let tools = tools_from_result(json!({
            "tools": [{"name":"search.query", "description":"Find", "inputSchema":{"type":"object"}}]
        }))
        .unwrap();
        assert_eq!(tools[0].id, "search.query");
        assert_eq!(tools[0].output_schema, json!({"type":"object"}));
    }

    #[test]
    fn headers_used_by_streamable_http_are_well_formed() {
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, HeaderValue::from_static(CLIENT_ORIGIN));
        headers.insert(
            "MCP-Protocol-Version",
            HeaderValue::from_static(MCP_PROTOCOL_VERSION),
        );
        assert_eq!(headers["MCP-Protocol-Version"], MCP_PROTOCOL_VERSION);
    }
}
