const EXPOSED_COMMANDS: &[&str] = &[
    "app_info",
    "app_quit",
    "command_execute",
    "dialog_choose_save_target",
    "dialog_open_directory",
    "dialog_open_files",
    "dialog_release_handle",
    "open_external_url",
    "provider_connect",
    "provider_disconnect",
    "provider_test",
    "runtime_cancel",
    "runtime_request",
    "runtime_status",
    "window_close",
    "window_close_response",
    "window_is_maximized",
    "window_minimize",
    "window_preferences_get",
    "window_preferences_set",
    "window_start_dragging",
    "window_toggle_maximize",
    "workspace_lock",
    "workspace_lock_status",
    "workspace_password_change",
    "workspace_password_setup",
    "workspace_use_windows_protection",
    "workspace_unlock",
];

fn main() {
    for attempt in 0..8 {
        let result = tauri_build::try_build(
            tauri_build::Attributes::new()
                .app_manifest(tauri_build::AppManifest::new().commands(EXPOSED_COMMANDS)),
        );
        match result {
            Ok(()) => return,
            Err(error)
                if attempt < 7
                    && (error.to_string().contains("used by another process")
                        || error.to_string().contains("os error 32")) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(125 * (attempt + 1)));
            }
            Err(error) => panic!("failed to generate the CupcakeAI Tauri host manifest: {error}"),
        }
    }
}
