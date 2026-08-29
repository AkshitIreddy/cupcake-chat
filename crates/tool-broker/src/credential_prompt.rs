//! Windows-owned secret entry. Provider API keys are typed into Credential UI
//! and returned directly to the broker vault; Electron/renderer IPC never sees
//! the plaintext.

use crate::vault::SecretBytes;
use crate::{BrokerError, Result};

#[cfg(windows)]
use windows_sys::Win32::Foundation::ERROR_CANCELLED;
#[cfg(windows)]
use windows_sys::Win32::Security::Credentials::{
    CredUIPromptForCredentialsW, CREDUI_FLAGS_ALWAYS_SHOW_UI, CREDUI_FLAGS_DO_NOT_PERSIST,
    CREDUI_FLAGS_GENERIC_CREDENTIALS, CREDUI_FLAGS_KEEP_USERNAME, CREDUI_FLAGS_PASSWORD_ONLY_OK,
    CREDUI_INFOW, CREDUI_MAX_USERNAME_LENGTH,
};
#[cfg(windows)]
use zeroize::Zeroize;

/// Show an OS-owned API-key prompt. No native window handle is accepted from
/// the renderer; Windows owns the modal credential surface.
#[cfg(windows)]
pub fn prompt_api_key(provider_label: &str) -> Result<SecretBytes> {
    if provider_label.trim().is_empty() || provider_label.len() > 80 {
        return Err(BrokerError::InvalidConfig(
            "invalid provider prompt label".into(),
        ));
    }
    let caption = wide("Connect provider");
    let message = wide(&format!(
        "Enter your {provider_label} API key. CUPCAKEAGI stores it with Windows DPAPI; the app interface never receives it."
    ));
    let target = wide(&format!("CUPCAKEAGI:{provider_label}:api-key"));
    let mut username = wide(provider_label);
    username.resize(CREDUI_MAX_USERNAME_LENGTH as usize, 0);
    // The legacy generic-credential prompt uses a caller-owned password
    // buffer. 1024 UTF-16 units safely covers current provider bearer keys.
    let mut password = vec![0_u16; 1024];
    let info = CREDUI_INFOW {
        cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
        hwndParent: std::ptr::null_mut(),
        pszMessageText: message.as_ptr(),
        pszCaptionText: caption.as_ptr(),
        hbmBanner: std::ptr::null_mut(),
    };
    let mut save = 0;
    // SAFETY: all pointers reference live, NUL-terminated caller-owned buffers;
    // capacities are passed in UTF-16 code units as required by CredUI.
    let status = unsafe {
        CredUIPromptForCredentialsW(
            &info,
            target.as_ptr(),
            std::ptr::null(),
            0,
            username.as_mut_ptr(),
            username.len() as u32,
            password.as_mut_ptr(),
            password.len() as u32,
            &mut save,
            CREDUI_FLAGS_GENERIC_CREDENTIALS
                | CREDUI_FLAGS_ALWAYS_SHOW_UI
                | CREDUI_FLAGS_DO_NOT_PERSIST
                | CREDUI_FLAGS_KEEP_USERNAME
                | CREDUI_FLAGS_PASSWORD_ONLY_OK,
        )
    };
    username.zeroize();
    if status == ERROR_CANCELLED {
        password.zeroize();
        return Err(BrokerError::PermissionDenied(
            "credential prompt was cancelled".into(),
        ));
    }
    if status != 0 {
        password.zeroize();
        return Err(BrokerError::VaultUnavailable(format!(
            "Windows credential prompt failed with status {status}"
        )));
    }
    let length = password
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(password.len());
    let text = String::from_utf16(&password[..length])
        .map_err(|_| BrokerError::InvalidConfig("API key is not valid Unicode".into()));
    password.zeroize();
    let mut bytes = text?.into_bytes();
    let secret = SecretBytes::new(std::mem::take(&mut bytes));
    bytes.zeroize();
    secret
}

#[cfg(not(windows))]
pub fn prompt_api_key(_provider_label: &str) -> Result<SecretBytes> {
    Err(BrokerError::VaultUnavailable(
        "interactive credential entry requires Windows".into(),
    ))
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
