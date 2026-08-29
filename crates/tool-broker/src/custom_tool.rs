//! Supervision for third-party custom-tool packages.
//!
//! Packages are always checksum-verified child processes. They receive a tiny,
//! versioned, length-prefixed JSON protocol over private pipes and never share
//! an address space, dynamic library handle, credential, or arbitrary broker
//! environment with CUPCAKEAGI.

use crate::framing::{read_frame, write_frame};
#[cfg(windows)]
use crate::registry::ResourceLimits;
use crate::sdk::CustomToolManifest;
use crate::{BrokerError, Result, PROTOCOL_VERSION};
use semver::{Version, VersionReq};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufReader, BufWriter};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use crate::process_containment::{assign_and_resume, CREATE_SUSPENDED_FLAG};
#[cfg(windows)]
use crate::sandbox::WindowsJob;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_INVOCATION_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CustomToolLimits {
    pub handshake_timeout: Duration,
    pub invocation_timeout: Duration,
    pub max_frame_bytes: usize,
    pub max_invocation_output_bytes: usize,
}

impl Default for CustomToolLimits {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(10),
            invocation_timeout: Duration::from_secs(60),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_invocation_output_bytes: DEFAULT_MAX_INVOCATION_OUTPUT_BYTES,
        }
    }
}

impl CustomToolLimits {
    fn validate(&self) -> Result<()> {
        if self.handshake_timeout.is_zero()
            || self.handshake_timeout > Duration::from_secs(60)
            || self.invocation_timeout.is_zero()
            || self.invocation_timeout > Duration::from_secs(60 * 60)
            || !(1024..=64 * 1024 * 1024).contains(&self.max_frame_bytes)
            || self.max_invocation_output_bytes < self.max_frame_bytes
            || self.max_invocation_output_bytes > 256 * 1024 * 1024
        {
            return Err(BrokerError::InvalidConfig(
                "invalid custom-tool timeout or output limits".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CustomToolProgress {
    pub invocation_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct CustomToolInvocationResult {
    pub invocation_id: String,
    pub output: Value,
}

/// Owns one isolated child per installed package. A crashed or cancelled child
/// is removed and must complete a fresh handshake before another invocation.
pub struct CustomToolSupervisor {
    sessions: Mutex<HashMap<String, Arc<CustomToolSession>>>,
    limits: CustomToolLimits,
}

impl CustomToolSupervisor {
    pub fn new(limits: CustomToolLimits) -> Result<Self> {
        limits.validate()?;
        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            limits,
        })
    }

    /// Verifies the package root, executable digest, broker compatibility, and
    /// initial tool allowlist before spawning a process with an empty env.
    pub fn start(
        &self,
        package_root: &Path,
        manifest: CustomToolManifest,
        allowed_tools: BTreeSet<String>,
    ) -> Result<()> {
        manifest.validate()?;
        let broker_requirement = VersionReq::parse(&manifest.broker_version).map_err(|error| {
            BrokerError::InvalidConfig(format!("invalid broker version requirement: {error}"))
        })?;
        let broker_version = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| {
            BrokerError::InvalidConfig(format!("invalid broker package version: {error}"))
        })?;
        let stable_release_line = Version::new(
            broker_version.major,
            broker_version.minor,
            broker_version.patch,
        );
        if !broker_requirement.matches(&broker_version)
            && !broker_requirement.matches(&stable_release_line)
        {
            return Err(BrokerError::InvalidConfig(format!(
                "custom-tool package requires broker {} but this broker is {}",
                manifest.broker_version, broker_version
            )));
        }
        let declared: BTreeSet<_> = manifest.tools.iter().map(|tool| tool.id.clone()).collect();
        if !allowed_tools.is_subset(&declared) {
            return Err(BrokerError::PermissionDenied(
                "custom-tool allowlist contains an undeclared tool".into(),
            ));
        }
        if self
            .sessions
            .lock()
            .expect("custom-tool sessions lock poisoned")
            .contains_key(&manifest.package_id)
        {
            return Err(BrokerError::Duplicate(manifest.package_id));
        }
        let executable = manifest.verify_executable(package_root)?;
        let session = Arc::new(CustomToolSession::launch(
            &executable,
            &manifest,
            allowed_tools,
            self.limits.clone(),
        )?);
        let mut sessions = self
            .sessions
            .lock()
            .expect("custom-tool sessions lock poisoned");
        if sessions.contains_key(&manifest.package_id) {
            session.terminate();
            return Err(BrokerError::Duplicate(manifest.package_id));
        }
        sessions.insert(manifest.package_id.clone(), session);
        Ok(())
    }

    pub fn invoke<F>(
        &self,
        package_id: &str,
        invocation_id: &str,
        tool_id: &str,
        arguments: Value,
        on_progress: F,
    ) -> Result<CustomToolInvocationResult>
    where
        F: FnMut(CustomToolProgress) -> Result<()>,
    {
        validate_invocation_id(invocation_id)?;
        let session = self.session(package_id)?;
        if !session.allowed_tools.contains(tool_id) {
            return Err(BrokerError::PermissionDenied(
                "custom tool is not allowlisted for this package session".into(),
            ));
        }
        let result = session.invoke(invocation_id, tool_id, arguments, on_progress);
        if result.is_err() && session.exited() {
            self.remove_if_same(package_id, &session);
        }
        result
    }

    /// Sends a protocol cancellation and terminates the process tree boundary.
    /// A package must perform a fresh verified handshake before reuse.
    pub fn cancel(&self, package_id: &str, invocation_id: &str, reason: &str) -> Result<()> {
        validate_invocation_id(invocation_id)?;
        if reason.len() > 1024 {
            return Err(BrokerError::InvalidConfig(
                "cancel reason is too long".into(),
            ));
        }
        let session = self.session(package_id)?;
        let _ = session.write(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": session.next_sequence(),
            "type": "cancel",
            "invocationId": invocation_id,
            "reason": reason
        }));
        session.terminate();
        self.remove_if_same(package_id, &session);
        Ok(())
    }

    pub fn stop(&self, package_id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .expect("custom-tool sessions lock poisoned")
            .remove(package_id)
            .ok_or_else(|| BrokerError::NotFound(package_id.into()))?;
        let _ = session.write(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": session.next_sequence(),
            "type": "shutdown"
        }));
        session.terminate();
        Ok(())
    }

    pub fn running_packages(&self) -> Vec<String> {
        let mut packages: Vec<_> = self
            .sessions
            .lock()
            .expect("custom-tool sessions lock poisoned")
            .keys()
            .cloned()
            .collect();
        packages.sort();
        packages
    }

    fn session(&self, package_id: &str) -> Result<Arc<CustomToolSession>> {
        self.sessions
            .lock()
            .expect("custom-tool sessions lock poisoned")
            .get(package_id)
            .cloned()
            .ok_or_else(|| BrokerError::NotFound(package_id.into()))
    }

    fn remove_if_same(&self, package_id: &str, expected: &Arc<CustomToolSession>) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("custom-tool sessions lock poisoned");
        if sessions
            .get(package_id)
            .is_some_and(|actual| Arc::ptr_eq(actual, expected))
        {
            sessions.remove(package_id);
        }
    }
}

impl Drop for CustomToolSupervisor {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.terminate();
            }
        }
    }
}

struct CustomToolSession {
    child: Arc<Mutex<Child>>,
    #[cfg(windows)]
    job: Arc<WindowsJob>,
    writer: Mutex<BufWriter<ChildStdin>>,
    responses: Mutex<mpsc::Receiver<std::result::Result<Value, String>>>,
    invocation_lock: Mutex<()>,
    sequence: AtomicU64,
    expected_response_sequence: AtomicU64,
    allowed_tools: BTreeSet<String>,
    limits: CustomToolLimits,
}

impl CustomToolSession {
    fn launch(
        executable: &Path,
        manifest: &CustomToolManifest,
        allowed_tools: BTreeSet<String>,
        limits: CustomToolLimits,
    ) -> Result<Self> {
        let mut command = Command::new(executable);
        command.args(&manifest.arguments).env_clear();
        for name in &manifest.inherited_environment {
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
                timeout_ms: limits.invocation_timeout.as_millis().min(u64::MAX as u128) as u64,
                max_output_bytes: limits.max_invocation_output_bytes,
                max_memory_bytes: Some(1024 * 1024 * 1024),
                max_cpu_seconds: None,
            },
            16,
        )?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("custom-tool stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("custom-tool stdout unavailable".into()))?;
        let (tx, rx) = mpsc::sync_channel(32);
        let maximum = limits.max_frame_bytes;
        thread::Builder::new()
            .name(format!("cupcake-custom-tool-{}", manifest.package_id))
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let result = read_frame::<_, Value>(&mut reader, maximum)
                        .map_err(|error| error.to_string());
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
            writer: Mutex::new(BufWriter::new(stdin)),
            responses: Mutex::new(rx),
            invocation_lock: Mutex::new(()),
            sequence: AtomicU64::new(1),
            expected_response_sequence: AtomicU64::new(1),
            allowed_tools,
            limits,
        };
        session.handshake(manifest)?;
        Ok(session)
    }

    fn handshake(&self, manifest: &CustomToolManifest) -> Result<()> {
        let descriptor_digest = hex::encode(Sha256::digest(serde_json::to_vec(&manifest.tools)?));
        self.write(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": self.next_sequence(),
            "type": "handshake",
            "broker": {"name":"CUPCAKEAGI", "version":env!("CARGO_PKG_VERSION")},
            "packageId": manifest.package_id,
            "packageVersion": manifest.package_version,
            "descriptorDigest": descriptor_digest
        }))?;
        let response = self.receive(self.limits.handshake_timeout)?;
        self.validate_response(&response)?;
        if response.get("type").and_then(Value::as_str) != Some("handshake_ok")
            || response.get("packageId").and_then(Value::as_str)
                != Some(manifest.package_id.as_str())
            || response.get("descriptorDigest").and_then(Value::as_str)
                != Some(descriptor_digest.as_str())
        {
            self.terminate();
            return Err(BrokerError::Integrity(
                "custom-tool handshake does not match its signed manifest".into(),
            ));
        }
        Ok(())
    }

    fn invoke<F>(
        &self,
        invocation_id: &str,
        tool_id: &str,
        arguments: Value,
        mut on_progress: F,
    ) -> Result<CustomToolInvocationResult>
    where
        F: FnMut(CustomToolProgress) -> Result<()>,
    {
        let _serial = self
            .invocation_lock
            .lock()
            .expect("custom-tool invocation lock poisoned");
        self.write(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": self.next_sequence(),
            "type": "invoke",
            "invocationId": invocation_id,
            "toolId": tool_id,
            "arguments": arguments
        }))?;
        let mut total = 0_usize;
        loop {
            let response = match self.receive(self.limits.invocation_timeout) {
                Ok(value) => value,
                Err(error) => {
                    self.terminate();
                    return Err(error);
                }
            };
            self.validate_response(&response)?;
            total = total.saturating_add(serde_json::to_vec(&response)?.len());
            if total > self.limits.max_invocation_output_bytes {
                self.terminate();
                return Err(BrokerError::FrameTooLarge {
                    actual: total,
                    maximum: self.limits.max_invocation_output_bytes,
                });
            }
            if response.get("invocationId").and_then(Value::as_str) != Some(invocation_id) {
                self.terminate();
                return Err(BrokerError::InvalidEnvelope(
                    "custom-tool response invocation ID mismatch".into(),
                ));
            }
            match response.get("type").and_then(Value::as_str) {
                Some("progress") => on_progress(CustomToolProgress {
                    invocation_id: invocation_id.into(),
                    payload: response.get("payload").cloned().unwrap_or(Value::Null),
                })?,
                Some("result") => {
                    return Ok(CustomToolInvocationResult {
                        invocation_id: invocation_id.into(),
                        output: response.get("output").cloned().unwrap_or(Value::Null),
                    })
                }
                Some("error") => {
                    return Err(BrokerError::InvalidEnvelope(format!(
                        "custom tool failed: {}",
                        bounded_error(response.get("error").unwrap_or(&Value::Null))
                    )))
                }
                _ => {
                    self.terminate();
                    return Err(BrokerError::InvalidEnvelope(
                        "custom-tool returned an unexpected message type".into(),
                    ));
                }
            }
        }
    }

    fn write(&self, value: Value) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .expect("custom-tool writer lock poisoned");
        write_frame(&mut *writer, &value, self.limits.max_frame_bytes)
    }

    fn receive(&self, timeout: Duration) -> Result<Value> {
        match self
            .responses
            .lock()
            .expect("custom-tool response lock poisoned")
            .recv_timeout(timeout)
        {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(BrokerError::InvalidEnvelope(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(BrokerError::InvalidEnvelope("custom-tool timed out".into()))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(BrokerError::InvalidEnvelope(
                "custom-tool closed its protocol stream".into(),
            )),
        }
    }

    fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    fn validate_response(&self, value: &Value) -> Result<()> {
        validate_response_envelope(value)?;
        let actual = value
            .get("sequence")
            .and_then(Value::as_u64)
            .expect("validated response sequence");
        let expected = self.expected_response_sequence.load(Ordering::Acquire);
        if actual != expected {
            return Err(BrokerError::SequenceViolation { expected, actual });
        }
        self.expected_response_sequence
            .store(expected.saturating_add(1), Ordering::Release);
        Ok(())
    }

    fn exited(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok().flatten())
            .is_some()
    }

    fn terminate(&self) {
        #[cfg(windows)]
        let _ = self.job.terminate(0xC0C0_0004);
        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

impl Drop for CustomToolSession {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn validate_response_envelope(value: &Value) -> Result<()> {
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64)
        || value.get("sequence").and_then(Value::as_u64).is_none()
        || value.get("type").and_then(Value::as_str).is_none()
    {
        return Err(BrokerError::InvalidEnvelope(
            "invalid custom-tool response envelope".into(),
        ));
    }
    Ok(())
}

fn validate_invocation_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(BrokerError::InvalidConfig(
            "invalid custom-tool invocation ID".into(),
        ));
    }
    Ok(())
}

fn bounded_error(value: &Value) -> String {
    let mut text = value.to_string();
    text.truncate(2048);
    text
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

    #[test]
    fn limits_fail_closed() {
        let limits = CustomToolLimits {
            handshake_timeout: Duration::ZERO,
            ..CustomToolLimits::default()
        };
        assert!(CustomToolSupervisor::new(limits).is_err());
    }

    #[test]
    fn response_envelope_is_versioned_and_sequenced() {
        assert!(validate_response_envelope(&json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": 1,
            "type": "result",
            "invocationId": "i"
        }))
        .is_ok());
        assert!(validate_response_envelope(&json!({
            "protocolVersion": 999,
            "sequence": 1,
            "type": "result"
        }))
        .is_err());
    }

    #[test]
    fn invocation_ids_are_bounded_protocol_values() {
        assert!(validate_invocation_id("018f7e10-demo_1").is_ok());
        assert!(validate_invocation_id("has spaces").is_err());
        assert!(validate_invocation_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn supervisor_starts_empty_and_stop_is_exact() {
        let supervisor = CustomToolSupervisor::new(CustomToolLimits::default()).unwrap();
        assert!(supervisor.running_packages().is_empty());
        assert!(matches!(
            supervisor.stop("missing"),
            Err(BrokerError::NotFound(_))
        ));
    }
}
