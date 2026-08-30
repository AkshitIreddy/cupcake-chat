use crate::allowlist::{ensure_provider_id, ensure_runtime_method_allowed};
use crate::error::{HostError, HostResult};
use crate::models::{
    AppInfo, DialogOpenOptions, OpaqueFileHandle, ProviderConnectionInput, RuntimeRequest,
    RuntimeResponse, RuntimeStatus, DESKTOP_API_VERSION, DESKTOP_COMMAND_EVENT_NAME,
    WINDOW_STATE_EVENT_NAME,
};
use crate::state::HostState;
use crate::url_policy::normalize_external_url;
use serde_json::Value;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROVIDER_SECRET_BYTES: usize = 16 * 1024;
const DESKTOP_COMMANDS: &[&str] = &[
    "app.about",
    "app.preferences",
    "chat.new",
    "chat.stop",
    "file.attach",
    "navigation.back",
    "navigation.forward",
    "search.open",
    "view.command-palette",
    "view.frosting-thread",
    "view.model-picker",
];

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, HostState>) -> AppInfo {
    AppInfo {
        api_version: DESKTOP_API_VERSION,
        app_version: app.package_info().version.to_string(),
        platform: "win32",
        packaged: !cfg!(debug_assertions),
        runtime: state.supervisor.status().state,
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle, state: State<'_, HostState>) {
    state.supervisor.stop();
    state.files.clear();
    app.exit(0);
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> HostResult<()> {
    window.minimize().map_err(HostError::from)
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> HostResult<bool> {
    if window.is_maximized().map_err(HostError::from)? {
        window.unmaximize().map_err(HostError::from)?;
    } else {
        window.maximize().map_err(HostError::from)?;
    }
    emit_window_state(&window);
    window.is_maximized().map_err(HostError::from)
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> HostResult<()> {
    window.close().map_err(HostError::from)
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> HostResult<bool> {
    window.is_maximized().map_err(HostError::from)
}

#[tauri::command]
pub fn window_start_dragging(window: WebviewWindow) -> HostResult<()> {
    window.start_dragging().map_err(HostError::from)
}

#[tauri::command]
pub fn command_execute(app: AppHandle, command: String) -> HostResult<()> {
    if !DESKTOP_COMMANDS.contains(&command.as_str()) {
        return Err(HostError::invalid("Unknown desktop command"));
    }
    app.emit(DESKTOP_COMMAND_EVENT_NAME, command)
        .map_err(|_| HostError::internal("The desktop command could not be dispatched"))
}

#[tauri::command]
pub async fn dialog_open_files(
    app: AppHandle,
    state: State<'_, HostState>,
    options: Option<DialogOpenOptions>,
) -> HostResult<Vec<OpaqueFileHandle>> {
    let options = validate_dialog_options(options.unwrap_or_default())?;
    let files = state.files.clone();
    let supervisor = state.supervisor.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(title) = options.title {
            builder = builder.set_title(title);
        }
        for filter in options.filters {
            let extensions = filter
                .extensions
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            builder = builder.add_filter(filter.name, &extensions);
        }
        let selected = if options.multiple {
            builder.blocking_pick_files().unwrap_or_default()
        } else {
            builder.blocking_pick_file().into_iter().collect()
        };
        selected
            .into_iter()
            .map(|path| {
                let path = path.into_path().map_err(|_| {
                    HostError::invalid("Only local filesystem selections are supported")
                })?;
                let public = files.register_existing(&path, false)?;
                if let Some(grant) = files.resolve(&public.id) {
                    supervisor.register_file_grant(grant)?;
                }
                Ok(public)
            })
            .collect()
    })
    .await
    .map_err(|_| HostError::internal("The file selection operation stopped unexpectedly"))?
}

#[tauri::command]
pub async fn dialog_open_directory(
    app: AppHandle,
    state: State<'_, HostState>,
    options: Option<DialogOpenOptions>,
) -> HostResult<Option<OpaqueFileHandle>> {
    let options = validate_dialog_options(options.unwrap_or_default())?;
    let files = state.files.clone();
    let supervisor = state.supervisor.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(title) = options.title {
            builder = builder.set_title(title);
        }
        let Some(path) = builder.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| HostError::invalid("Only local filesystem selections are supported"))?;
        let public = files.register_existing(&path, false)?;
        if let Some(grant) = files.resolve(&public.id) {
            supervisor.register_file_grant(grant)?;
        }
        Ok(Some(public))
    })
    .await
    .map_err(|_| HostError::internal("The directory selection operation stopped unexpectedly"))?
}

#[tauri::command]
pub async fn dialog_choose_save_target(
    app: AppHandle,
    state: State<'_, HostState>,
    suggested_name: Option<String>,
) -> HostResult<Option<OpaqueFileHandle>> {
    let suggested_name = validate_suggested_name(suggested_name)?;
    let files = state.files.clone();
    let supervisor = state.supervisor.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(name) = suggested_name {
            builder = builder.set_file_name(name);
        }
        let Some(path) = builder.blocking_save_file() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| HostError::invalid("Only local filesystem selections are supported"))?;
        let public = files.register_save_target(&path)?;
        if let Some(grant) = files.resolve(&public.id) {
            supervisor.register_file_grant(grant)?;
        }
        Ok(Some(public))
    })
    .await
    .map_err(|_| HostError::internal("The save selection operation stopped unexpectedly"))?
}

#[tauri::command]
pub fn dialog_release_handle(state: State<'_, HostState>, handle_id: String) {
    if state.files.release(&handle_id).is_some() {
        state.supervisor.release_file_grant(&handle_id);
    }
}

#[tauri::command]
pub async fn runtime_request(
    state: State<'_, HostState>,
    request: RuntimeRequest,
) -> HostResult<RuntimeResponse> {
    ensure_runtime_method_allowed(&request.method)?;
    if serde_json::to_vec(&request)
        .map_err(|_| HostError::invalid("Runtime request is invalid"))?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err(HostError::invalid("Runtime request exceeds the size limit"));
    }
    for grant in resolve_attachment_grants(&request.params, &state)? {
        state.supervisor.register_file_grant(grant)?;
    }
    let supervisor = state.supervisor.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        supervisor.request(request.method, request.params, request.timeout_ms)
    })
    .await
    .unwrap_or_else(|_| {
        RuntimeResponse::failure(
            "RUNTIME_STOPPED",
            "The local runtime operation stopped unexpectedly",
            true,
        )
    }))
}

#[tauri::command]
pub fn runtime_status(state: State<'_, HostState>) -> RuntimeStatus {
    state.supervisor.status()
}

#[tauri::command]
pub fn runtime_cancel(state: State<'_, HostState>, request_id: String) -> bool {
    state.supervisor.cancel(&request_id)
}

#[tauri::command]
pub async fn provider_test(
    state: State<'_, HostState>,
    input: ProviderConnectionInput,
) -> HostResult<RuntimeResponse> {
    provider_call(state, input, "providers.test").await
}

#[tauri::command]
pub async fn provider_connect(
    state: State<'_, HostState>,
    input: ProviderConnectionInput,
) -> HostResult<RuntimeResponse> {
    provider_call(state, input, "providers.connect").await
}

#[tauri::command]
pub async fn provider_disconnect(
    state: State<'_, HostState>,
    provider: String,
) -> HostResult<RuntimeResponse> {
    ensure_provider_id(&provider)?;
    let supervisor = state.supervisor.clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || supervisor.provider_disconnect(provider))
            .await
            .unwrap_or_else(|_| {
                RuntimeResponse::failure(
                    "RUNTIME_STOPPED",
                    "The provider operation stopped unexpectedly",
                    true,
                )
            }),
    )
}

#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> HostResult<()> {
    let url = normalize_external_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| HostError::internal("The external URL could not be opened"))
}

async fn provider_call(
    state: State<'_, HostState>,
    input: ProviderConnectionInput,
    method: &'static str,
) -> HostResult<RuntimeResponse> {
    ensure_provider_id(&input.provider)?;
    if input.secret.is_empty()
        || input.secret.len() > MAX_PROVIDER_SECRET_BYTES
        || input.secret.contains('\0')
    {
        return Err(HostError::invalid("Provider secret is invalid"));
    }
    for value in [
        input.base_url.as_deref(),
        input.organization.as_deref(),
        input.model_id.as_deref(),
        input.display_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.len() > 2_048 || value.chars().any(char::is_control) {
            return Err(HostError::invalid("Provider option is invalid"));
        }
    }
    let ProviderConnectionInput {
        provider,
        secret,
        base_url,
        organization,
        model_id,
        display_name,
    } = input;
    let secret = Zeroizing::new(secret);
    let supervisor = state.supervisor.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        supervisor.provider_request(
            method,
            crate::sidecar::SensitiveProviderRequest {
                provider,
                secret,
                base_url,
                organization,
                model_id,
                display_name,
            },
        )
    })
    .await
    .unwrap_or_else(|_| {
        RuntimeResponse::failure(
            "RUNTIME_STOPPED",
            "The provider operation stopped unexpectedly",
            true,
        )
    }))
}

fn resolve_attachment_grants(
    params: &Value,
    state: &State<'_, HostState>,
) -> HostResult<Vec<crate::file_handles::InternalFileGrant>> {
    let Some(params) = params.as_object() else {
        return Ok(Vec::new());
    };
    let compact = params
        .get("attachmentHandles")
        .map(parse_compact_ids)
        .transpose()?;
    let structured = params
        .get("attachments")
        .map(parse_structured_ids)
        .transpose()?;
    let ids = match (compact, structured) {
        (Some(left), Some(right)) if left != right => {
            return Err(HostError::invalid("Attachment handle lists do not match"))
        }
        (Some(ids), _) | (_, Some(ids)) => ids,
        (None, None) => return Ok(Vec::new()),
    };
    state.files.resolve_active_attachments(&ids)
}

fn parse_compact_ids(value: &Value) -> HostResult<Vec<String>> {
    let values = value
        .as_array()
        .ok_or_else(|| HostError::invalid("Attachment handles must be an array"))?;
    parse_unique_ids(values.iter().map(Value::as_str))
}

fn parse_structured_ids(value: &Value) -> HostResult<Vec<String>> {
    let values = value
        .as_array()
        .ok_or_else(|| HostError::invalid("Attachments must be an array"))?;
    parse_unique_ids(values.iter().map(|value| {
        value.as_object().and_then(|attachment| {
            (attachment.len() == 1)
                .then(|| attachment.get("handleId").and_then(Value::as_str))
                .flatten()
        })
    }))
}

fn parse_unique_ids<'a>(values: impl Iterator<Item = Option<&'a str>>) -> HostResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for value in values {
        let value = value.ok_or_else(|| HostError::invalid("Attachment handle is invalid"))?;
        let id = Uuid::parse_str(value)
            .map_err(|_| HostError::invalid("Attachment handle is invalid"))?;
        if !seen.insert(id) {
            return Err(HostError::invalid("Attachment handles must be unique"));
        }
        ids.push(id.to_string());
    }
    if ids.len() > 32 {
        return Err(HostError::invalid(
            "A request may contain at most 32 attachments",
        ));
    }
    Ok(ids)
}

fn validate_dialog_options(mut options: DialogOpenOptions) -> HostResult<DialogOpenOptions> {
    if let Some(title) = options.title.as_ref() {
        if title.len() > 128 || title.chars().any(char::is_control) {
            return Err(HostError::invalid("Dialog title is invalid"));
        }
    }
    if options.filters.len() > 16 {
        return Err(HostError::invalid("Too many dialog filters"));
    }
    for filter in &mut options.filters {
        if filter.name.is_empty()
            || filter.name.len() > 64
            || filter.extensions.is_empty()
            || filter.extensions.len() > 32
        {
            return Err(HostError::invalid("Dialog filter is invalid"));
        }
        for extension in &mut filter.extensions {
            *extension = extension.trim_start_matches('.').to_ascii_lowercase();
            if extension.is_empty()
                || extension.len() > 16
                || !extension
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'*')
            {
                return Err(HostError::invalid("Dialog extension is invalid"));
            }
        }
    }
    Ok(options)
}

fn validate_suggested_name(value: Option<String>) -> HostResult<Option<String>> {
    value
        .map(|value| {
            if value.is_empty()
                || value.len() > 128
                || value.chars().any(char::is_control)
                || value.contains(['/', '\\'])
            {
                Err(HostError::invalid("Suggested file name is invalid"))
            } else {
                Ok(value)
            }
        })
        .transpose()
}

pub fn emit_window_state(window: &WebviewWindow) {
    let payload = crate::models::WindowStatePayload {
        maximized: window.is_maximized().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        scale_factor: window.scale_factor().unwrap_or(1.0),
    };
    let _ = window.emit(WINDOW_STATE_EVENT_NAME, payload);
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        emit_window_state(&window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn attachment_contract_is_path_free_unique_and_bounded() {
        let id = Uuid::now_v7().to_string();
        assert_eq!(
            parse_structured_ids(&json!([{"handleId": id}]))
                .unwrap()
                .len(),
            1
        );
        assert!(parse_structured_ids(&json!([{"handleId": id, "absolutePath": "C:/x"}])).is_err());
        assert!(parse_compact_ids(&json!([id, id])).is_err());
    }

    #[test]
    fn save_name_rejects_path_injection() {
        assert!(validate_suggested_name(Some("../secret.txt".into())).is_err());
        assert_eq!(
            validate_suggested_name(Some("notes.txt".into())).unwrap(),
            Some("notes.txt".into())
        );
    }

    #[test]
    fn renderer_command_surface_is_closed() {
        assert!(!DESKTOP_COMMANDS.contains(&"shell.open"));
        assert!(DESKTOP_COMMANDS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
