use crate::error::{HostError, HostResult};
use crate::models::RuntimeState;
use crate::state::HostState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

pub const UPDATE_PROGRESS_EVENT_NAME: &str = "cupcake://update-progress";
const PRODUCTION_UPDATE_ENDPOINT: &str =
    "https://github.com/AkshitIreddy/cupcake-chat/releases/latest/download/latest.json";

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct AppUpdateState {
    busy: AtomicBool,
    pending: Mutex<Option<PendingUpdate>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub configured: bool,
    pub current_version: String,
    pub endpoint: String,
    pub busy: bool,
    pub available_version: Option<String>,
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub target: String,
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub available: bool,
    pub update: Option<AppUpdateMetadata>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgress {
    pub stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

pub fn public_key() -> &'static str {
    option_env!("CUPCAKE_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("")
}

fn selected_endpoint() -> HostResult<Url> {
    let test_profile = std::env::var_os("CUPCAKE_TEST_DATA_DIR").is_some();
    let test_endpoint = std::env::var("CUPCAKE_UPDATER_TEST_ENDPOINT").ok();
    select_endpoint(test_profile, test_endpoint.as_deref())
}

fn select_endpoint(test_profile: bool, test_endpoint: Option<&str>) -> HostResult<Url> {
    if let Some(value) = test_endpoint {
        if !test_profile {
            return Err(HostError::new(
                "UPDATE_CONFIGURATION_INVALID",
                "A test update feed requires an isolated test profile",
                false,
            ));
        }
        let endpoint = Url::parse(value).map_err(|_| {
            HostError::new(
                "UPDATE_CONFIGURATION_INVALID",
                "The test update feed URL is invalid",
                false,
            )
        })?;
        if !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost")) {
            return Err(HostError::new(
                "UPDATE_CONFIGURATION_INVALID",
                "The test update feed must use a loopback host",
                false,
            ));
        }
        return Ok(endpoint);
    }

    Url::parse(PRODUCTION_UPDATE_ENDPOINT).map_err(|_| {
        HostError::new(
            "UPDATE_CONFIGURATION_INVALID",
            "The production update feed URL is invalid",
            false,
        )
    })
}

fn ensure_configured() -> HostResult<()> {
    if public_key().is_empty() {
        return Err(HostError::new(
            "UPDATE_NOT_CONFIGURED",
            "This build does not contain the Cupcake Chat update verification key",
            false,
        ));
    }
    Ok(())
}

fn ensure_idle(state: &AppUpdateState) -> HostResult<()> {
    if state.busy.swap(true, Ordering::AcqRel) {
        Err(HostError::new(
            "UPDATE_BUSY",
            "Another update operation is already running",
            true,
        ))
    } else {
        Ok(())
    }
}

fn finish_operation(state: &AppUpdateState) {
    state.busy.store(false, Ordering::Release);
}

fn lock_pending(
    state: &AppUpdateState,
) -> HostResult<std::sync::MutexGuard<'_, Option<PendingUpdate>>> {
    state.pending.lock().map_err(|_| {
        HostError::new(
            "UPDATE_STATE_ERROR",
            "The update state could not be read",
            true,
        )
    })
}

fn update_metadata(update: &Update, downloaded: bool) -> AppUpdateMetadata {
    AppUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone(),
        published_at: update.date.map(|date| date.to_string()),
        target: update.target.clone(),
        downloaded,
    }
}

fn emit_progress(app: &AppHandle, payload: AppUpdateProgress) {
    let _ = app.emit(UPDATE_PROGRESS_EVENT_NAME, payload);
}

fn update_failure(message: &'static str) -> HostError {
    HostError::new("UPDATE_FAILED", message, true)
}

#[tauri::command]
pub fn app_update_status(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> HostResult<AppUpdateStatus> {
    let endpoint = selected_endpoint()?;
    let pending = lock_pending(&state)?;
    Ok(AppUpdateStatus {
        configured: !public_key().is_empty(),
        current_version: app.package_info().version.to_string(),
        endpoint: endpoint.to_string(),
        busy: state.busy.load(Ordering::Acquire),
        available_version: pending.as_ref().map(|item| item.update.version.clone()),
        downloaded: pending.as_ref().is_some_and(|item| item.bytes.is_some()),
    })
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> HostResult<AppUpdateCheckResult> {
    ensure_configured()?;
    ensure_idle(&state)?;
    emit_progress(
        &app,
        AppUpdateProgress {
            stage: "checking",
            version: None,
            downloaded_bytes: None,
            total_bytes: None,
        },
    );

    let result = async {
        let endpoint = selected_endpoint()?;
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|_| update_failure("The update feed could not be configured"))?
            .pubkey(public_key())
            .build()
            .map_err(|_| update_failure("The update service could not be started"))?;
        let update = updater
            .check()
            .await
            .map_err(|_| update_failure("Cupcake Chat could not check for updates"))?;

        if let Some(update) = update {
            let metadata = update_metadata(&update, false);
            *lock_pending(&state)? = Some(PendingUpdate {
                update,
                bytes: None,
            });
            emit_progress(
                &app,
                AppUpdateProgress {
                    stage: "available",
                    version: Some(metadata.version.clone()),
                    downloaded_bytes: None,
                    total_bytes: None,
                },
            );
            Ok(AppUpdateCheckResult {
                available: true,
                update: Some(metadata),
            })
        } else {
            *lock_pending(&state)? = None;
            emit_progress(
                &app,
                AppUpdateProgress {
                    stage: "upToDate",
                    version: None,
                    downloaded_bytes: None,
                    total_bytes: None,
                },
            );
            Ok(AppUpdateCheckResult {
                available: false,
                update: None,
            })
        }
    }
    .await;

    finish_operation(&state);
    if result.is_err() {
        emit_progress(
            &app,
            AppUpdateProgress {
                stage: "failed",
                version: None,
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
    }
    result
}

#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> HostResult<AppUpdateMetadata> {
    ensure_configured()?;
    ensure_idle(&state)?;
    let result = async {
        let update = lock_pending(&state)?
            .as_ref()
            .map(|item| item.update.clone())
            .ok_or_else(|| {
                HostError::new(
                    "UPDATE_NOT_AVAILABLE",
                    "Check for an update before downloading it",
                    false,
                )
            })?;
        let version = update.version.clone();
        emit_progress(
            &app,
            AppUpdateProgress {
                stage: "downloadStarted",
                version: Some(version.clone()),
                downloaded_bytes: Some(0),
                total_bytes: None,
            },
        );

        let progress_app = app.clone();
        let progress_version = version.clone();
        let mut downloaded = 0_u64;
        let bytes = update
            .download(
                move |chunk_length, total| {
                    downloaded = downloaded.saturating_add(chunk_length as u64);
                    emit_progress(
                        &progress_app,
                        AppUpdateProgress {
                            stage: "downloadProgress",
                            version: Some(progress_version.clone()),
                            downloaded_bytes: Some(downloaded),
                            total_bytes: total,
                        },
                    );
                },
                || {},
            )
            .await
            .map_err(|_| update_failure("The update download or signature verification failed"))?;

        let metadata = update_metadata(&update, true);
        *lock_pending(&state)? = Some(PendingUpdate {
            update,
            bytes: Some(bytes),
        });
        emit_progress(
            &app,
            AppUpdateProgress {
                stage: "downloadVerified",
                version: Some(version),
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
        Ok(metadata)
    }
    .await;

    finish_operation(&state);
    if result.is_err() {
        emit_progress(
            &app,
            AppUpdateProgress {
                stage: "failed",
                version: None,
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
    }
    result
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    update_state: State<'_, AppUpdateState>,
    host_state: State<'_, HostState>,
) -> HostResult<()> {
    ensure_configured()?;
    ensure_idle(&update_state)?;
    let result = async {
        let pending = lock_pending(&update_state)?.take().ok_or_else(|| {
            HostError::new(
                "UPDATE_NOT_DOWNLOADED",
                "Download and verify the update before installing it",
                false,
            )
        })?;
        let PendingUpdate { update, bytes } = pending;
        let Some(bytes) = bytes else {
            *lock_pending(&update_state)? = Some(PendingUpdate {
                update,
                bytes: None,
            });
            return Err(HostError::new(
                "UPDATE_NOT_DOWNLOADED",
                "Download and verify the update before installing it",
                false,
            ));
        };
        let version = update.version.clone();
        emit_progress(
            &app,
            AppUpdateProgress {
                stage: "installing",
                version: Some(version),
                downloaded_bytes: None,
                total_bytes: None,
            },
        );

        let supervisor = host_state.supervisor.clone();
        let restart_runtime = matches!(
            supervisor.status().state,
            RuntimeState::Starting | RuntimeState::Ready | RuntimeState::Degraded
        );
        let stop_supervisor = supervisor.clone();
        tauri::async_runtime::spawn_blocking(move || stop_supervisor.stop())
            .await
            .map_err(|_| update_failure("The local runtime could not stop for the update"))?;

        if update.install(&bytes).is_err() {
            if restart_runtime {
                let _ = supervisor.start();
            }
            *lock_pending(&update_state)? = Some(PendingUpdate {
                update,
                bytes: Some(bytes),
            });
            return Err(update_failure("The verified update could not be installed"));
        }
        Ok(())
    }
    .await;

    finish_operation(&update_state);
    if result.is_err() {
        emit_progress(
            &app,
            AppUpdateProgress {
                stage: "failed",
                version: None,
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_feed_is_fixed_https() {
        let endpoint = select_endpoint(false, None).unwrap();
        assert_eq!(endpoint.as_str(), PRODUCTION_UPDATE_ENDPOINT);
        assert_eq!(endpoint.scheme(), "https");
    }

    #[test]
    fn test_feed_requires_isolated_profile_and_loopback() {
        assert!(select_endpoint(false, Some("http://127.0.0.1:43121/latest.json")).is_err());
        assert!(select_endpoint(true, Some("https://example.com/latest.json")).is_err());
        let endpoint = select_endpoint(true, Some("http://localhost:43121/latest.json")).unwrap();
        assert_eq!(endpoint.host_str(), Some("localhost"));
    }
}
