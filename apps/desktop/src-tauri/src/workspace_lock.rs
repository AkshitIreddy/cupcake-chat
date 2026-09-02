use crate::error::{HostError, HostResult};
use crate::models::{WorkspaceLockState, WorkspaceLockStatus, WorkspaceUnlockMode};
use crate::sidecar::SidecarSupervisor;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, SaltString};
use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use uuid::Uuid;
use zeroize::Zeroizing;

const PASSWORD_MIN_CHARACTERS: usize = 15;
const PASSWORD_MAX_CHARACTERS: usize = 128;
const PASSWORD_MAX_BYTES: usize = 512;
const WINDOWS_PROTECTION_ALGORITHM: &str = "WindowsDPAPI";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordRecord {
    version: u16,
    algorithm: String,
    verifier: String,
    created_at: String,
    updated_at: String,
}

struct LockInner {
    record: Option<PasswordRecord>,
    unlocked: bool,
    failed_attempts: u32,
    retry_at: Option<Instant>,
}

pub struct WorkspaceLock {
    record_path: PathBuf,
    supervisor: Arc<SidecarSupervisor>,
    inner: Mutex<LockInner>,
}

impl WorkspaceLock {
    pub fn load(
        data_directory: &Path,
        supervisor: Arc<SidecarSupervisor>,
    ) -> HostResult<Arc<Self>> {
        let record_path = data_directory.join("security").join("workspace-lock.json");
        let record = if record_path.is_file() {
            let bytes = fs::read(&record_path).map_err(|_| {
                HostError::internal("The workspace password record could not be read")
            })?;
            let record: PasswordRecord = serde_json::from_slice(&bytes).map_err(|_| {
                HostError::internal("The workspace password record is damaged or unsupported")
            })?;
            validate_record(&record)?;
            Some(record)
        } else {
            None
        };
        let unlocked = record
            .as_ref()
            .is_some_and(|item| item.algorithm == WINDOWS_PROTECTION_ALGORITHM);
        Ok(Arc::new(Self {
            record_path,
            supervisor,
            inner: Mutex::new(LockInner {
                record,
                unlocked,
                failed_attempts: 0,
                retry_at: None,
            }),
        }))
    }

    pub fn status(&self) -> WorkspaceLockStatus {
        status_for(&self.lock())
    }

    pub fn setup(&self, password: Zeroizing<String>) -> HostResult<WorkspaceLockStatus> {
        if !password.is_empty() {
            validate_password(&password)?;
        }
        let mut inner = self.lock();
        if inner.record.is_some() {
            return Err(HostError::invalid("A workspace password already exists"));
        }
        let record = if password.is_empty() {
            windows_protected_record(None)
        } else {
            hash_password(&password, None)?
        };
        write_record(&self.record_path, &record)?;
        inner.record = Some(record);
        inner.unlocked = true;
        inner.failed_attempts = 0;
        inner.retry_at = None;
        drop(inner);
        let _ = self.supervisor.start();
        Ok(self.status())
    }

    pub fn unlock(&self, password: Zeroizing<String>) -> HostResult<WorkspaceLockStatus> {
        let (verifier, windows_protected) = {
            let inner = self.lock();
            enforce_retry_boundary(&inner)?;
            let record = inner
                .record
                .as_ref()
                .ok_or_else(|| HostError::invalid("Create a workspace profile first"))?;
            (
                record.verifier.clone(),
                record.algorithm == WINDOWS_PROTECTION_ALGORITHM,
            )
        };
        let verified = windows_protected || verify_password(&password, &verifier);
        let mut inner = self.lock();
        if !verified {
            inner.failed_attempts = inner.failed_attempts.saturating_add(1);
            let delay_ms = 500_u64
                .saturating_mul(1_u64 << inner.failed_attempts.saturating_sub(1).min(6))
                .min(30_000);
            inner.retry_at = Some(Instant::now() + Duration::from_millis(delay_ms));
            return Err(HostError::new(
                "WORKSPACE_PASSWORD_INCORRECT",
                "That CupcakeAI password is not correct",
                true,
            ));
        }
        inner.unlocked = true;
        inner.failed_attempts = 0;
        inner.retry_at = None;
        drop(inner);
        let _ = self.supervisor.start();
        Ok(self.status())
    }

    pub fn lock_workspace(&self) -> WorkspaceLockStatus {
        {
            let mut inner = self.lock();
            if inner.record.is_some() {
                inner.unlocked = false;
            }
        }
        self.supervisor.stop();
        self.status()
    }

    pub fn change_password(
        &self,
        current_password: Zeroizing<String>,
        new_password: Zeroizing<String>,
    ) -> HostResult<WorkspaceLockStatus> {
        validate_password(&new_password)?;
        let (verifier, created_at) = {
            let inner = self.lock();
            if !inner.unlocked {
                return Err(HostError::new(
                    "WORKSPACE_LOCKED",
                    "Unlock the workspace before changing its password",
                    false,
                ));
            }
            enforce_retry_boundary(&inner)?;
            let record = inner
                .record
                .as_ref()
                .ok_or_else(|| HostError::invalid("Create a workspace password first"))?;
            (record.verifier.clone(), record.created_at.clone())
        };
        if !verify_password(&current_password, &verifier) {
            return Err(HostError::new(
                "WORKSPACE_PASSWORD_INCORRECT",
                "The current CupcakeAI password is not correct",
                true,
            ));
        }
        let record = hash_password(&new_password, Some(created_at))?;
        write_record(&self.record_path, &record)?;
        let mut inner = self.lock();
        inner.record = Some(record);
        inner.failed_attempts = 0;
        inner.retry_at = None;
        Ok(status_for(&inner))
    }

    fn lock(&self) -> MutexGuard<'_, LockInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn argon2id() -> HostResult<Argon2<'static>> {
    let params = Params::new(19 * 1024, 2, 1, None)
        .map_err(|_| HostError::internal("The password hashing policy is invalid"))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

fn hash_password(password: &str, created_at: Option<String>) -> HostResult<PasswordRecord> {
    let salt = SaltString::generate(&mut OsRng);
    let verifier = argon2id()?
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| HostError::internal("The workspace password could not be protected"))?
        .to_string();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(PasswordRecord {
        version: 1,
        algorithm: "Argon2id".to_owned(),
        verifier,
        created_at: created_at.unwrap_or_else(|| now.clone()),
        updated_at: now,
    })
}

fn windows_protected_record(created_at: Option<String>) -> PasswordRecord {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    PasswordRecord {
        version: 2,
        algorithm: WINDOWS_PROTECTION_ALGORITHM.to_owned(),
        verifier: String::new(),
        created_at: created_at.unwrap_or_else(|| now.clone()),
        updated_at: now,
    }
}

fn verify_password(password: &str, verifier: &str) -> bool {
    PasswordHash::new(verifier)
        .ok()
        .zip(argon2id().ok())
        .is_some_and(|(parsed, hasher)| {
            hasher.verify_password(password.as_bytes(), &parsed).is_ok()
        })
}

fn validate_password(password: &str) -> HostResult<()> {
    let characters = password.chars().count();
    if !(PASSWORD_MIN_CHARACTERS..=PASSWORD_MAX_CHARACTERS).contains(&characters)
        || password.len() > PASSWORD_MAX_BYTES
        || password.contains('\0')
    {
        return Err(HostError::invalid(format!(
            "Use {PASSWORD_MIN_CHARACTERS} to {PASSWORD_MAX_CHARACTERS} characters for the CupcakeAI password"
        )));
    }
    Ok(())
}

fn validate_record(record: &PasswordRecord) -> HostResult<()> {
    let password_record = record.version == 1
        && record.algorithm == "Argon2id"
        && PasswordHash::new(&record.verifier).is_ok();
    let windows_record = record.version == 2
        && record.algorithm == WINDOWS_PROTECTION_ALGORITHM
        && record.verifier.is_empty();
    if !password_record && !windows_record {
        return Err(HostError::internal(
            "The workspace password record is damaged or unsupported",
        ));
    }
    Ok(())
}

fn enforce_retry_boundary(inner: &LockInner) -> HostResult<()> {
    if let Some(retry_at) = inner.retry_at {
        if retry_at > Instant::now() {
            return Err(HostError::new(
                "WORKSPACE_RETRY_LATER",
                "Wait briefly before trying the workspace password again",
                true,
            ));
        }
    }
    Ok(())
}

fn status_for(inner: &LockInner) -> WorkspaceLockStatus {
    let state = if inner.record.is_none() {
        WorkspaceLockState::NeedsSetup
    } else if inner.unlocked {
        WorkspaceLockState::Unlocked
    } else {
        WorkspaceLockState::Locked
    };
    let retry_after_ms = inner
        .retry_at
        .and_then(|retry_at| retry_at.checked_duration_since(Instant::now()))
        .map(|duration| duration.as_millis().min(u128::from(u32::MAX)) as u32)
        .unwrap_or(0);
    WorkspaceLockStatus {
        state,
        unlock_mode: inner.record.as_ref().map(|record| {
            if record.algorithm == WINDOWS_PROTECTION_ALGORITHM {
                WorkspaceUnlockMode::Windows
            } else {
                WorkspaceUnlockMode::Password
            }
        }),
        failed_attempts: inner.failed_attempts,
        retry_after_ms,
    }
}

fn write_record(path: &Path, record: &PasswordRecord) -> HostResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| HostError::internal("The workspace security directory is invalid"))?;
    fs::create_dir_all(parent).map_err(|_| {
        HostError::internal("The workspace security directory could not be created")
    })?;
    let temporary = parent.join(format!(".workspace-lock-{}.tmp", Uuid::now_v7()));
    let bytes = serde_json::to_vec(record)
        .map_err(|_| HostError::internal("The workspace password record could not be encoded"))?;
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(HostError::internal(
            "The workspace password record could not be saved",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        hash_password, validate_password, validate_record, verify_password,
        windows_protected_record,
    };

    #[test]
    fn password_policy_accepts_long_unicode_passphrases() {
        assert!(validate_password("correct horse battery staple 🧁").is_ok());
        assert!(validate_password("too short").is_err());
    }

    #[test]
    fn argon2id_record_verifies_only_the_matching_password() {
        let record = hash_password("correct horse battery staple", None).unwrap();
        assert!(record.verifier.starts_with("$argon2id$"));
        assert!(verify_password(
            "correct horse battery staple",
            &record.verifier
        ));
        assert!(!verify_password(
            "incorrect password value",
            &record.verifier
        ));
    }

    #[test]
    fn windows_protected_profile_has_no_app_password_verifier() {
        let record = windows_protected_record(None);
        assert_eq!(record.version, 2);
        assert!(record.verifier.is_empty());
        assert!(validate_record(&record).is_ok());
    }
}
