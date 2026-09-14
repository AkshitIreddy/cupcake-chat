use crate::error::{HostError, HostResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn preferences_io(_: std::io::Error) -> HostError {
    HostError::internal("Window preferences could not be saved on this computer")
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupBehavior {
    Open,
    Minimized,
    Tray,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    Ask,
    Tray,
    Quit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MinimizeBehavior {
    Taskbar,
    Tray,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowPreferences {
    pub startup_behavior: StartupBehavior,
    pub close_behavior: CloseBehavior,
    pub minimize_behavior: MinimizeBehavior,
    pub show_in_taskbar: bool,
    pub always_on_top: bool,
    pub launch_at_login: bool,
}

impl Default for WindowPreferences {
    fn default() -> Self {
        Self {
            startup_behavior: StartupBehavior::Open,
            close_behavior: CloseBehavior::Quit,
            minimize_behavior: MinimizeBehavior::Taskbar,
            show_in_taskbar: true,
            always_on_top: false,
            launch_at_login: false,
        }
    }
}

pub struct WindowPreferencesStore {
    path: PathBuf,
    current: Mutex<WindowPreferences>,
}

impl WindowPreferencesStore {
    pub fn load(data_directory: &Path) -> HostResult<Self> {
        let path = data_directory.join("window-preferences.json");
        let current = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| HostError::invalid("Window preferences are malformed"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                WindowPreferences::default()
            }
            Err(error) => return Err(preferences_io(error)),
        };
        Ok(Self {
            path,
            current: Mutex::new(current),
        })
    }

    pub fn get(&self) -> WindowPreferences {
        self.current
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn set(&self, preferences: WindowPreferences) -> HostResult<WindowPreferences> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(preferences_io)?;
        }
        let bytes = serde_json::to_vec_pretty(&preferences)
            .map_err(|_| HostError::internal("Window preferences could not be encoded"))?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(preferences_io)?;
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(preferences_io)?;
        }
        fs::rename(&temporary, &self.path).map_err(preferences_io)?;
        *self
            .current
            .lock()
            .map_err(|_| HostError::internal("Window preferences are unavailable"))? =
            preferences.clone();
        Ok(preferences)
    }
}

#[cfg(windows)]
pub fn set_launch_at_login(enabled: bool) -> HostResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }

    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide("Cupcake Chat");
    let legacy_name = wide("CupcakeAI");
    let mut key = null_mut();
    let result = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            null(),
            &mut key,
            null_mut(),
        )
    };
    if result != ERROR_SUCCESS {
        return Err(HostError::internal(
            "Windows startup registration could not be opened",
        ));
    }
    let operation = if enabled {
        let executable = std::env::current_exe().map_err(preferences_io)?;
        let command = wide(format!("\"{}\"", executable.display()));
        let result = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                command.as_ptr().cast(),
                (command.len() * std::mem::size_of::<u16>()) as u32,
            )
        };
        if result == ERROR_SUCCESS {
            unsafe { RegDeleteValueW(key, legacy_name.as_ptr()) };
        }
        result
    } else {
        let current_result = unsafe { RegDeleteValueW(key, name.as_ptr()) };
        let legacy_result = unsafe { RegDeleteValueW(key, legacy_name.as_ptr()) };
        if current_result != ERROR_SUCCESS && current_result != ERROR_FILE_NOT_FOUND {
            current_result
        } else if legacy_result != ERROR_SUCCESS && legacy_result != ERROR_FILE_NOT_FOUND {
            legacy_result
        } else {
            ERROR_SUCCESS
        }
    };
    unsafe { RegCloseKey(key) };
    if operation != ERROR_SUCCESS {
        return Err(HostError::internal(
            "Windows startup registration could not be updated",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_launch_at_login(_enabled: bool) -> HostResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let store = WindowPreferencesStore::load(directory.path()).unwrap();
        let preferences = WindowPreferences {
            startup_behavior: StartupBehavior::Tray,
            close_behavior: CloseBehavior::Quit,
            minimize_behavior: MinimizeBehavior::Tray,
            show_in_taskbar: false,
            always_on_top: true,
            launch_at_login: false,
        };
        store.set(preferences.clone()).unwrap();
        assert_eq!(store.get(), preferences);
        assert_eq!(
            WindowPreferencesStore::load(directory.path())
                .unwrap()
                .get(),
            preferences
        );
    }
}
