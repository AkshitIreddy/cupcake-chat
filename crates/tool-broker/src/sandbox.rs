use crate::registry::ResourceLimits;
use crate::{BrokerError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{WindowsJob, WindowsSandbox};

pub const HARD_MAX_ARGUMENTS: usize = 256;
pub const HARD_MAX_ARGUMENT_BYTES: usize = 256 * 1024;
pub const HARD_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const HARD_MAX_TIMEOUT_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    Denied,
    LoopbackOnly,
    AllowlistedOrigins,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessPlan {
    /// Broker registry ID mapped to an administrator-approved executable path.
    pub executable_id: String,
    /// Arguments are an array and never interpreted by a command shell.
    pub arguments: Vec<String>,
    /// Opaque filesystem grant; the path is resolved only inside the broker.
    pub working_directory_grant: String,
    /// Environment values are supplied by broker-owned bindings, not inline.
    pub environment_bindings: BTreeMap<String, String>,
    pub network: NetworkPolicy,
    pub network_origins: BTreeSet<String>,
    pub limits: ResourceLimits,
    pub read_only_root: bool,
}

impl ProcessPlan {
    pub fn validate(&self) -> Result<()> {
        if self.executable_id.is_empty()
            || !self.executable_id.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
            })
        {
            return Err(BrokerError::InvalidConfig("invalid executable ID".into()));
        }
        let argument_bytes: usize = self.arguments.iter().map(String::len).sum();
        if self.arguments.len() > HARD_MAX_ARGUMENTS || argument_bytes > HARD_MAX_ARGUMENT_BYTES {
            return Err(BrokerError::InvalidConfig(
                "process arguments exceed hard bounds".into(),
            ));
        }
        if self
            .arguments
            .iter()
            .any(|argument| argument.contains('\0'))
        {
            return Err(BrokerError::InvalidConfig(
                "process argument contains NUL".into(),
            ));
        }
        if self.working_directory_grant.is_empty() {
            return Err(BrokerError::InvalidConfig(
                "working-directory grant is required".into(),
            ));
        }
        if self.environment_bindings.iter().any(|(name, binding)| {
            name.is_empty()
                || binding.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                || name.contains("SECRET")
                || name.contains("TOKEN")
                || name.contains("PASSWORD")
                || name.contains("KEY")
        }) {
            return Err(BrokerError::InvalidConfig(
                "environment bindings contain an invalid or credential-like name".into(),
            ));
        }
        if self.network == NetworkPolicy::Denied && !self.network_origins.is_empty() {
            return Err(BrokerError::InvalidConfig(
                "denied network plan cannot contain origins".into(),
            ));
        }
        if self.network == NetworkPolicy::AllowlistedOrigins && self.network_origins.is_empty() {
            return Err(BrokerError::InvalidConfig(
                "allowlisted network plan requires an origin".into(),
            ));
        }
        if self.limits.timeout_ms == 0
            || self.limits.timeout_ms > HARD_MAX_TIMEOUT_MS
            || self.limits.max_output_bytes == 0
            || self.limits.max_output_bytes > HARD_MAX_OUTPUT_BYTES
        {
            return Err(BrokerError::InvalidConfig(
                "process limits are outside hard broker bounds".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedProcessPlan {
    /// Unique broker-owned identifier used for cancellation and audit lineage.
    pub execution_id: String,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub network: NetworkPolicy,
    pub network_origins: BTreeSet<String>,
    pub limits: ResourceLimits,
    pub read_only_root: bool,
}

impl ResolvedProcessPlan {
    pub fn validate_paths(&self) -> Result<()> {
        if self.execution_id.is_empty()
            || self.execution_id.len() > 128
            || !self
                .execution_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            || !self.executable.is_absolute()
            || !self.executable.is_file()
            || !self.working_directory.is_absolute()
            || !self.working_directory.is_dir()
            || is_shell(&self.executable)
        {
            return Err(BrokerError::InvalidConfig(
                "resolved process paths are missing, relative, or shell-based".into(),
            ));
        }
        if self.arguments.len() > HARD_MAX_ARGUMENTS
            || self.arguments.iter().map(String::len).sum::<usize>() > HARD_MAX_ARGUMENT_BYTES
            || self.arguments.iter().any(|value| value.contains('\0'))
            || self.environment.iter().any(|(name, value)| {
                name.is_empty()
                    || name.contains('=')
                    || name.contains('\0')
                    || value.contains('\0')
                    || !name.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                    || name.contains("SECRET")
                    || name.contains("TOKEN")
                    || name.contains("PASSWORD")
                    || name.contains("KEY")
            })
        {
            return Err(BrokerError::InvalidConfig(
                "resolved arguments or environment are unsafe".into(),
            ));
        }
        if self.network == NetworkPolicy::Denied && !self.network_origins.is_empty() {
            return Err(BrokerError::InvalidConfig(
                "denied network plan cannot contain origins".into(),
            ));
        }
        if self.limits.timeout_ms == 0
            || self.limits.timeout_ms > HARD_MAX_TIMEOUT_MS
            || self.limits.max_output_bytes == 0
            || self.limits.max_output_bytes > HARD_MAX_OUTPUT_BYTES
        {
            return Err(BrokerError::InvalidConfig(
                "resolved process limits are outside hard broker bounds".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Queued,
    Preparing,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
    TimedOut,
    OutputLimitExceeded,
}

impl ProcessState {
    pub fn transition(self, to: Self) -> Result<Self> {
        let valid = matches!(
            (self, to),
            (Self::Queued, Self::Preparing)
                | (Self::Queued, Self::Cancelled)
                | (Self::Preparing, Self::Running)
                | (Self::Preparing, Self::Failed)
                | (Self::Preparing, Self::Cancelled)
                | (Self::Running, Self::Cancelling)
                | (Self::Running, Self::Completed)
                | (Self::Running, Self::Failed)
                | (Self::Running, Self::TimedOut)
                | (Self::Running, Self::OutputLimitExceeded)
                | (Self::Cancelling, Self::Cancelled)
                | (Self::Cancelling, Self::Failed)
        );
        if valid {
            Ok(to)
        } else {
            Err(BrokerError::InvalidTransition {
                from: format!("{self:?}"),
                to: format!("{to:?}"),
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct SandboxOutput {
    pub state: ProcessState,
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// A platform adapter must enforce the plan below the process boundary (Job
/// Objects/AppContainer on Windows, sandbox-exec/seatbelt replacement on macOS,
/// namespaces/seccomp/cgroups on Linux). The default deliberately refuses to
/// execute: an unproven platform never silently falls back to a raw child.
pub trait SandboxBackend: Send + Sync {
    fn execute(&self, plan: &ResolvedProcessPlan) -> Result<SandboxOutput>;
    fn cancel(&self, execution_id: &str) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct DisabledSandbox;

impl SandboxBackend for DisabledSandbox {
    fn execute(&self, _plan: &ResolvedProcessPlan) -> Result<SandboxOutput> {
        Err(BrokerError::SandboxUnavailable(
            "no verified native sandbox backend is installed".into(),
        ))
    }

    fn cancel(&self, _execution_id: &str) -> Result<()> {
        Err(BrokerError::SandboxUnavailable(
            "no verified native sandbox backend is installed".into(),
        ))
    }
}

/// Captures interleaved output without allowing either stream to exceed the
/// total result bound. Callers terminate the process tree when `push` returns
/// false.
#[derive(Debug)]
pub struct BoundedOutput {
    maximum: usize,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exceeded: bool,
}

impl BoundedOutput {
    pub fn new(maximum: usize) -> Result<Self> {
        if maximum == 0 || maximum > HARD_MAX_OUTPUT_BYTES {
            return Err(BrokerError::InvalidConfig("invalid output bound".into()));
        }
        Ok(Self {
            maximum,
            stdout: Vec::new(),
            stderr: Vec::new(),
            exceeded: false,
        })
    }

    pub fn push_stdout(&mut self, bytes: &[u8]) -> bool {
        push_bounded(
            &mut self.stdout,
            self.stderr.len(),
            self.maximum,
            bytes,
            &mut self.exceeded,
        )
    }

    pub fn push_stderr(&mut self, bytes: &[u8]) -> bool {
        push_bounded(
            &mut self.stderr,
            self.stdout.len(),
            self.maximum,
            bytes,
            &mut self.exceeded,
        )
    }

    pub fn into_parts(self) -> (Vec<u8>, Vec<u8>, bool) {
        (self.stdout, self.stderr, self.exceeded)
    }
}

fn push_bounded(
    target: &mut Vec<u8>,
    other_len: usize,
    maximum: usize,
    bytes: &[u8],
    exceeded: &mut bool,
) -> bool {
    let remaining = maximum.saturating_sub(target.len() + other_len);
    if bytes.len() > remaining {
        target.extend_from_slice(&bytes[..remaining]);
        *exceeded = true;
        false
    } else {
        target.extend_from_slice(bytes);
        true
    }
}

fn is_shell(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "sh" | "bash"
                    | "zsh"
                    | "fish"
                    | "cmd"
                    | "cmd.exe"
                    | "powershell"
                    | "powershell.exe"
                    | "pwsh"
                    | "pwsh.exe"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> ProcessPlan {
        ProcessPlan {
            executable_id: "python.sandboxed".into(),
            arguments: vec!["-I".into(), "program.py".into()],
            working_directory_grant: "fs_opaque".into(),
            environment_bindings: BTreeMap::new(),
            network: NetworkPolicy::Denied,
            network_origins: BTreeSet::new(),
            limits: ResourceLimits::default(),
            read_only_root: true,
        }
    }

    #[test]
    fn plan_is_argument_based_and_bounded() {
        plan().validate().unwrap();
        let mut bad = plan();
        bad.arguments = vec!["x".repeat(HARD_MAX_ARGUMENT_BYTES + 1)];
        assert!(bad.validate().is_err());
        let mut secret_env = plan();
        secret_env
            .environment_bindings
            .insert("API_KEY".into(), "binding".into());
        assert!(secret_env.validate().is_err());
    }

    #[test]
    fn output_limit_is_total_across_streams() {
        let mut output = BoundedOutput::new(5).unwrap();
        assert!(output.push_stdout(b"abc"));
        assert!(!output.push_stderr(b"def"));
        let (stdout, stderr, exceeded) = output.into_parts();
        assert_eq!(stdout, b"abc");
        assert_eq!(stderr, b"de");
        assert!(exceeded);
    }

    #[test]
    fn process_state_machine_is_terminal() {
        let state = ProcessState::Queued
            .transition(ProcessState::Preparing)
            .unwrap()
            .transition(ProcessState::Running)
            .unwrap()
            .transition(ProcessState::Completed)
            .unwrap();
        assert!(state.transition(ProcessState::Running).is_err());
    }
}
