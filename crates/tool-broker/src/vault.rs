use crate::{BrokerError, Result};
use std::collections::HashMap;
use std::sync::RwLock;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[cfg(unix)]
const SERVICE: &str = "com.cupcakeagi.desktop";

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > 64 * 1024 {
            return Err(BrokerError::InvalidConfig(
                "credential must contain 1..65536 bytes".into(),
            ));
        }
        Ok(Self(bytes))
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

pub trait CredentialVault: Send + Sync {
    fn backend_name(&self) -> &'static str;
    fn is_persistent(&self) -> bool;
    fn store(&self, account: &str, secret: &SecretBytes) -> Result<()>;
    fn load(&self, account: &str) -> Result<Option<SecretBytes>>;
    fn delete(&self, account: &str) -> Result<bool>;
}

/// Safe fallback: credentials are process-memory-only and zeroized on removal
/// or broker shutdown. It never silently writes plaintext to disk.
#[derive(Default)]
pub struct SessionCredentialVault {
    secrets: RwLock<HashMap<String, SecretBytes>>,
}

impl CredentialVault for SessionCredentialVault {
    fn backend_name(&self) -> &'static str {
        "session-memory"
    }

    fn is_persistent(&self) -> bool {
        false
    }

    fn store(&self, account: &str, secret: &SecretBytes) -> Result<()> {
        validate_account(account)?;
        self.secrets
            .write()
            .expect("session vault lock poisoned")
            .insert(account.into(), secret.clone());
        Ok(())
    }

    fn load(&self, account: &str) -> Result<Option<SecretBytes>> {
        validate_account(account)?;
        Ok(self
            .secrets
            .read()
            .expect("session vault lock poisoned")
            .get(account)
            .cloned())
    }

    fn delete(&self, account: &str) -> Result<bool> {
        validate_account(account)?;
        Ok(self
            .secrets
            .write()
            .expect("session vault lock poisoned")
            .remove(account)
            .is_some())
    }
}

pub struct SelectedVault {
    inner: Box<dyn CredentialVault>,
    fallback_reason: Option<String>,
}

impl SelectedVault {
    pub fn inner(&self) -> &dyn CredentialVault {
        self.inner.as_ref()
    }

    pub fn fallback_reason(&self) -> Option<&str> {
        self.fallback_reason.as_deref()
    }

    /// Transfers ownership to a long-lived broker service. The vault remains
    /// behind the object-safe boundary so transports can never downcast it or
    /// obtain platform-specific credential primitives.
    pub fn into_inner(self) -> Box<dyn CredentialVault> {
        self.inner
    }
}

/// Selects a platform-native vault. Linux explicitly falls back to session-only
/// storage when Secret Service is unavailable; other unsupported targets do the
/// same and surface the reason to settings/developer diagnostics.
pub fn select_platform_vault() -> SelectedVault {
    #[cfg(windows)]
    {
        match windows::DpapiVault::new() {
            Ok(vault) => SelectedVault {
                inner: Box::new(vault),
                fallback_reason: None,
            },
            Err(error) => SelectedVault {
                inner: Box::new(SessionCredentialVault::default()),
                fallback_reason: Some(error.to_string()),
            },
        }
    }
    #[cfg(target_os = "macos")]
    {
        SelectedVault {
            inner: Box::new(macos::KeychainVault),
            fallback_reason: None,
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if linux::SecretServiceVault::available() {
            SelectedVault {
                inner: Box::new(linux::SecretServiceVault),
                fallback_reason: None,
            }
        } else {
            SelectedVault {
                inner: Box::new(SessionCredentialVault::default()),
                fallback_reason: Some(
                    "Linux Secret Service helper is unavailable; credentials are session-only"
                        .into(),
                ),
            }
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        SelectedVault {
            inner: Box::new(SessionCredentialVault::default()),
            fallback_reason: Some("no supported platform credential vault".into()),
        }
    }
}

fn validate_account(account: &str) -> Result<()> {
    if account.is_empty()
        || account.len() > 512
        || account.contains('\0')
        || account.chars().any(char::is_control)
    {
        return Err(BrokerError::InvalidConfig(
            "invalid credential account identifier".into(),
        ));
    }
    Ok(())
}

/// Protect a self-contained recovery secret for the current Windows user.
/// Unlike a vault entry, the returned DPAPI blob can be stored inside a backup
/// and recovered even when CupcakeAI's credential directory was lost.
#[cfg(windows)]
pub(crate) fn protect_for_current_windows_user(bytes: &[u8]) -> Result<Vec<u8>> {
    windows::DpapiVault::protect(bytes)
}

#[cfg(not(windows))]
pub(crate) fn protect_for_current_windows_user(_bytes: &[u8]) -> Result<Vec<u8>> {
    Err(BrokerError::VaultUnavailable(
        "backup recovery key protection requires Windows DPAPI".into(),
    ))
}

#[cfg(windows)]
pub(crate) fn unprotect_for_current_windows_user(bytes: &[u8]) -> Result<Vec<u8>> {
    windows::DpapiVault::unprotect(bytes)
}

#[cfg(not(windows))]
pub(crate) fn unprotect_for_current_windows_user(_bytes: &[u8]) -> Result<Vec<u8>> {
    Err(BrokerError::VaultUnavailable(
        "backup recovery key protection requires Windows DPAPI".into(),
    ))
}

#[cfg(all(unix, not(target_os = "macos")))]
mod linux {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub struct SecretServiceVault;

    impl SecretServiceVault {
        pub fn available() -> bool {
            Command::new("secret-tool")
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
    }

    impl CredentialVault for SecretServiceVault {
        fn backend_name(&self) -> &'static str {
            "linux-secret-service"
        }

        fn is_persistent(&self) -> bool {
            true
        }

        fn store(&self, account: &str, secret: &SecretBytes) -> Result<()> {
            validate_account(account)?;
            let mut child = Command::new("secret-tool")
                .args([
                    "store",
                    "--label",
                    "CupcakeAI credential",
                    "service",
                    SERVICE,
                    "account",
                    account,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| BrokerError::VaultUnavailable(error.to_string()))?;
            child
                .stdin
                .take()
                .ok_or_else(|| {
                    BrokerError::VaultUnavailable("secret-tool stdin unavailable".into())
                })?
                .write_all(secret.expose())?;
            if !child.wait()?.success() {
                return Err(BrokerError::VaultUnavailable(
                    "Secret Service rejected credential storage".into(),
                ));
            }
            Ok(())
        }

        fn load(&self, account: &str) -> Result<Option<SecretBytes>> {
            validate_account(account)?;
            let output = Command::new("secret-tool")
                .args(["lookup", "service", SERVICE, "account", account])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .map_err(|error| BrokerError::VaultUnavailable(error.to_string()))?;
            if !output.status.success() {
                return Ok(None);
            }
            let mut bytes = output.stdout;
            while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                bytes.pop();
            }
            Ok(Some(SecretBytes::new(bytes)?))
        }

        fn delete(&self, account: &str) -> Result<bool> {
            validate_account(account)?;
            Ok(Command::new("secret-tool")
                .args(["clear", "service", SERVICE, "account", account])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|error| BrokerError::VaultUnavailable(error.to_string()))?
                .success())
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub struct KeychainVault;

    impl CredentialVault for KeychainVault {
        fn backend_name(&self) -> &'static str {
            "macos-keychain"
        }
        fn is_persistent(&self) -> bool {
            true
        }
        fn store(&self, account: &str, secret: &SecretBytes) -> Result<()> {
            validate_account(account)?;
            set_generic_password(SERVICE, account, secret.expose())
                .map_err(|error| BrokerError::VaultUnavailable(error.to_string()))
        }
        fn load(&self, account: &str) -> Result<Option<SecretBytes>> {
            validate_account(account)?;
            match get_generic_password(SERVICE, account) {
                Ok(secret) => Ok(Some(SecretBytes::new(secret)?)),
                Err(_) => Ok(None),
            }
        }
        fn delete(&self, account: &str) -> Result<bool> {
            validate_account(account)?;
            match delete_generic_password(SERVICE, account) {
                Ok(()) => Ok(true),
                Err(_) => Ok(false),
            }
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub struct DpapiVault {
        directory: PathBuf,
    }

    impl DpapiVault {
        pub fn new() -> Result<Self> {
            let base = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
                BrokerError::VaultUnavailable("LOCALAPPDATA is unavailable".into())
            })?;
            let directory = PathBuf::from(base).join("CUPCAKEAGI").join("credentials");
            std::fs::create_dir_all(&directory)?;
            Ok(Self { directory })
        }

        fn path(&self, account: &str) -> PathBuf {
            self.directory
                .join(hex::encode(Sha256::digest(account.as_bytes())))
        }

        pub(super) fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
            let input = CRYPT_INTEGER_BLOB {
                cbData: bytes.len() as u32,
                pbData: bytes.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let ok = unsafe {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 {
                return Err(BrokerError::VaultUnavailable(
                    "DPAPI encryption failed".into(),
                ));
            }
            let protected =
                unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }
                    .to_vec();
            unsafe { LocalFree(output.pbData.cast()) };
            Ok(protected)
        }

        pub(super) fn unprotect(bytes: &[u8]) -> Result<Vec<u8>> {
            let input = CRYPT_INTEGER_BLOB {
                cbData: bytes.len() as u32,
                pbData: bytes.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let ok = unsafe {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 {
                return Err(BrokerError::VaultUnavailable(
                    "DPAPI decryption failed".into(),
                ));
            }
            let secret =
                unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }
                    .to_vec();
            unsafe { LocalFree(output.pbData.cast()) };
            Ok(secret)
        }
    }

    impl CredentialVault for DpapiVault {
        fn backend_name(&self) -> &'static str {
            "windows-dpapi"
        }
        fn is_persistent(&self) -> bool {
            true
        }
        fn store(&self, account: &str, secret: &SecretBytes) -> Result<()> {
            validate_account(account)?;
            let encrypted = Self::protect(secret.expose())?;
            std::fs::write(self.path(account), encrypted)?;
            Ok(())
        }
        fn load(&self, account: &str) -> Result<Option<SecretBytes>> {
            validate_account(account)?;
            let path = self.path(account);
            if !path.exists() {
                return Ok(None);
            }
            Ok(Some(SecretBytes::new(Self::unprotect(&std::fs::read(
                path,
            )?)?)?))
        }
        fn delete(&self, account: &str) -> Result<bool> {
            validate_account(account)?;
            let path = self.path(account);
            if !path.exists() {
                return Ok(false);
            }
            std::fs::remove_file(path)?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_vault_round_trip_and_delete() {
        let vault = SessionCredentialVault::default();
        let secret = SecretBytes::new(b"not-logged".to_vec()).unwrap();
        vault.store("provider:openai", &secret).unwrap();
        assert_eq!(
            vault.load("provider:openai").unwrap().unwrap().expose(),
            b"not-logged"
        );
        assert!(vault.delete("provider:openai").unwrap());
        assert!(vault.load("provider:openai").unwrap().is_none());
    }

    #[test]
    fn account_identifiers_reject_controls() {
        let vault = SessionCredentialVault::default();
        let secret = SecretBytes::new(vec![1]).unwrap();
        assert!(vault.store("bad\naccount", &secret).is_err());
    }
}
