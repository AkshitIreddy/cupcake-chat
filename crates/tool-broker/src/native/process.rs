use crate::registry::ResourceLimits;
use crate::{BrokerError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "operation")]
pub enum GitInspection {
    Status,
    Diff {
        staged: bool,
        pathspec: Vec<String>,
    },
    Log {
        maximum_commits: u16,
    },
    Show {
        revision: String,
        path: Option<String>,
    },
    Branches,
}

#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub output_exceeded: bool,
    pub cancelled: bool,
}

#[derive(Debug)]
pub struct FixedGitRunner {
    executable: PathBuf,
    active: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

impl FixedGitRunner {
    pub fn new(executable: &Path) -> Result<Self> {
        let executable = executable.canonicalize()?;
        if !executable.is_file() {
            return Err(BrokerError::InvalidConfig(
                "Git executable is not a file".into(),
            ));
        }
        let name = executable
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let valid = if cfg!(windows) {
            name.eq_ignore_ascii_case("git.exe")
        } else {
            name == "git"
        };
        if !valid {
            return Err(BrokerError::InvalidConfig(
                "Git executable must be a fixed git/git.exe binary".into(),
            ));
        }
        Ok(Self {
            executable,
            active: Mutex::new(HashMap::new()),
        })
    }

    pub fn inspect(
        &self,
        execution_id: &str,
        repository: &Path,
        inspection: &GitInspection,
        limits: &ResourceLimits,
    ) -> Result<ProcessOutput> {
        validate_execution_id(execution_id)?;
        let repository = repository.canonicalize()?;
        if !repository.join(".git").exists() {
            return Err(BrokerError::InvalidConfig(
                "Git inspection target is not a worktree".into(),
            ));
        }
        let arguments = typed_git_arguments(inspection)?;
        let mut command = Command::new(&self.executable);
        command
            .args(arguments)
            .current_dir(&repository)
            .env_clear()
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", platform_null_device())
            .env("GIT_PAGER", "cat")
            .env("GIT_EXTERNAL_DIFF", "")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
        }
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("Git stdout pipe is unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| BrokerError::InvalidConfig("Git stderr pipe is unavailable".into()))?;
        let child = Arc::new(Mutex::new(child));
        {
            let mut active = self.active.lock().map_err(poisoned)?;
            if active
                .insert(execution_id.to_owned(), Arc::clone(&child))
                .is_some()
            {
                return Err(BrokerError::Duplicate(execution_id.into()));
            }
        }
        let _registration = Registration {
            active: &self.active,
            execution_id,
        };
        let total = Arc::new(AtomicUsize::new(0));
        let exceeded = Arc::new(AtomicBool::new(false));
        let stdout_reader = spawn_bounded_reader(
            stdout,
            limits.max_output_bytes,
            Arc::clone(&total),
            Arc::clone(&exceeded),
        );
        let stderr_reader = spawn_bounded_reader(
            stderr,
            limits.max_output_bytes,
            Arc::clone(&total),
            Arc::clone(&exceeded),
        );
        let deadline = Instant::now() + Duration::from_millis(limits.timeout_ms);
        let mut timed_out = false;
        let mut cancelled = false;
        let exit_code = loop {
            if exceeded.load(Ordering::Acquire) {
                child.lock().map_err(poisoned)?.kill()?;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                child.lock().map_err(poisoned)?.kill()?;
            }
            let mut guarded = child.lock().map_err(poisoned)?;
            if let Some(status) = guarded.try_wait()? {
                break status.code().unwrap_or(-1);
            }
            if timed_out || exceeded.load(Ordering::Acquire) {
                let status = guarded.wait()?;
                break status.code().unwrap_or(-1);
            }
            drop(guarded);
            thread::sleep(Duration::from_millis(10));
        };
        if exit_code == -1 && !timed_out && !exceeded.load(Ordering::Acquire) {
            cancelled = true;
        }
        let stdout = stdout_reader
            .join()
            .map_err(|_| BrokerError::Integrity("Git stdout reader panicked".into()))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| BrokerError::Integrity("Git stderr reader panicked".into()))??;
        Ok(ProcessOutput {
            exit_code,
            stdout,
            stderr,
            timed_out,
            output_exceeded: exceeded.load(Ordering::Acquire),
            cancelled,
        })
    }

    pub fn cancel(&self, execution_id: &str) -> Result<()> {
        let child = self
            .active
            .lock()
            .map_err(poisoned)?
            .get(execution_id)
            .cloned()
            .ok_or_else(|| BrokerError::NotFound(execution_id.into()))?;
        child.lock().map_err(poisoned)?.kill()?;
        Ok(())
    }
}

fn typed_git_arguments(inspection: &GitInspection) -> Result<Vec<String>> {
    let mut arguments = vec![
        "--no-pager".into(),
        "-c".into(),
        "core.hooksPath=NUL".into(),
        "-c".into(),
        "diff.external=".into(),
    ];
    match inspection {
        GitInspection::Status => {
            arguments.extend(["status".into(), "--short".into(), "--branch".into()]);
        }
        GitInspection::Diff { staged, pathspec } => {
            validate_pathspecs(pathspec)?;
            arguments.extend([
                "diff".into(),
                "--no-ext-diff".into(),
                "--no-textconv".into(),
            ]);
            if *staged {
                arguments.push("--cached".into());
            }
            if !pathspec.is_empty() {
                arguments.push("--".into());
                arguments.extend(pathspec.iter().cloned());
            }
        }
        GitInspection::Log { maximum_commits } => {
            if *maximum_commits == 0 || *maximum_commits > 500 {
                return Err(BrokerError::InvalidConfig(
                    "Git log count is outside bounds".into(),
                ));
            }
            arguments.extend([
                "log".into(),
                format!("--max-count={maximum_commits}"),
                "--date=iso-strict".into(),
                "--format=%H%x09%aI%x09%an%x09%s".into(),
            ]);
        }
        GitInspection::Show { revision, path } => {
            validate_revision(revision)?;
            arguments.extend([
                "show".into(),
                "--no-ext-diff".into(),
                "--no-textconv".into(),
                "--format=fuller".into(),
                revision.clone(),
            ]);
            if let Some(path) = path {
                validate_pathspecs(std::slice::from_ref(path))?;
                arguments.extend(["--".into(), path.clone()]);
            }
        }
        GitInspection::Branches => {
            arguments.extend([
                "branch".into(),
                "--list".into(),
                "--no-color".into(),
                "--format=%(refname:short)%09%(objectname)".into(),
            ]);
        }
    }
    Ok(arguments)
}

fn validate_revision(revision: &str) -> Result<()> {
    if revision.is_empty()
        || revision.len() > 256
        || revision.starts_with('-')
        || revision.contains('\0')
        || revision.chars().any(char::is_whitespace)
    {
        return Err(BrokerError::InvalidConfig("invalid Git revision".into()));
    }
    Ok(())
}

fn validate_pathspecs(values: &[String]) -> Result<()> {
    if values.len() > 128 {
        return Err(BrokerError::InvalidConfig("too many Git pathspecs".into()));
    }
    for value in values {
        if value.is_empty()
            || value.len() > 4_096
            || value.starts_with('-')
            || value.starts_with(':')
            || value.contains('\0')
            || Path::new(value).is_absolute()
            || Path::new(value)
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(BrokerError::InvalidConfig("unsafe Git pathspec".into()));
        }
    }
    Ok(())
}

fn validate_execution_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(BrokerError::InvalidConfig("invalid execution ID".into()));
    }
    Ok(())
}

fn spawn_bounded_reader<R: Read + Send + 'static>(
    mut reader: R,
    maximum: usize,
    total: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                return Ok(output);
            }
            let start = total.fetch_add(read, Ordering::AcqRel);
            let remaining = maximum.saturating_sub(start);
            if read > remaining {
                output.extend_from_slice(&chunk[..remaining]);
                exceeded.store(true, Ordering::Release);
                return Ok(output);
            }
            output.extend_from_slice(&chunk[..read]);
        }
    })
}

struct Registration<'a> {
    active: &'a Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    execution_id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(self.execution_id);
        }
    }
}

fn poisoned<T>(_error: std::sync::PoisonError<T>) -> BrokerError {
    BrokerError::Integrity("native process state lock was poisoned".into())
}

#[cfg(windows)]
fn platform_null_device() -> &'static str {
    "NUL"
}

#[cfg(not(windows))]
fn platform_null_device() -> &'static str {
    "/dev/null"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_git_arguments_reject_option_and_magic_injection() {
        for path in ["--output=/tmp/stolen", ":(attr:filter)secret", "../escape"] {
            let inspection = GitInspection::Diff {
                staged: false,
                pathspec: vec![path.into()],
            };
            assert!(typed_git_arguments(&inspection).is_err(), "{path}");
        }
        for revision in ["--exec=oops", "HEAD\n--bad", ""] {
            assert!(typed_git_arguments(&GitInspection::Show {
                revision: revision.into(),
                path: None,
            })
            .is_err());
        }
    }

    #[test]
    fn only_closed_git_operation_set_can_produce_arguments() {
        let arguments = typed_git_arguments(&GitInspection::Log {
            maximum_commits: 25,
        })
        .unwrap();
        assert_eq!(arguments[0], "--no-pager");
        assert!(arguments.contains(&"--max-count=25".to_string()));
        assert!(!arguments.iter().any(|argument| argument.contains("&&")));
    }
}
