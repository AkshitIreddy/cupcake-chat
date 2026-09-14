mod allowlist;
mod app_updates;
mod commands;
mod error;
mod file_handles;
mod lifecycle;
mod manifest;
mod models;
mod process_job;
mod sidecar;
mod state;
mod tray;
mod url_policy;
mod window_preferences;
mod workspace_lock;

use crate::commands::*;
use crate::state::HostState;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    let updater_plugin = tauri_plugin_updater::Builder::new()
        .pubkey(app_updates::public_key())
        .build();
    let app = tauri::Builder::default()
        // Single-instance must be the first plugin so a second process never
        // initializes its own credential or sidecar boundary.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            lifecycle::handle_single_instance(app, argv);
        }))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-policy")
                .on_navigation(|_webview, url| url_policy::allow_webview_navigation(url))
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(updater_plugin)
        .invoke_handler(tauri::generate_handler![
            app_updates::app_update_check,
            app_updates::app_update_download,
            app_updates::app_update_install,
            app_updates::app_update_status,
            app_info,
            app_quit,
            command_execute,
            dialog_choose_save_target,
            dialog_open_directory,
            dialog_open_files,
            dialog_release_handle,
            open_external_url,
            provider_connect,
            provider_disconnect,
            provider_test,
            runtime_cancel,
            runtime_request,
            runtime_status,
            window_close,
            window_close_response,
            window_is_maximized,
            window_minimize,
            window_preferences_get,
            window_preferences_set,
            window_start_dragging,
            window_toggle_maximize,
            workspace_lock,
            workspace_lock_status,
            workspace_password_change,
            workspace_password_setup,
            workspace_protection_disable,
            workspace_unlock,
        ])
        .setup(|app| {
            let resource_directory = app.path().resource_dir()?.join("sidecars");
            let data_directory = state::test_profile_directory(
                std::env::var_os("CUPCAKE_TEST_DATA_DIR")
                    .as_deref()
                    .map(std::path::Path::new),
            )?
            .unwrap_or(app.path().app_data_dir()?.join("runtime"));
            let supervisor = sidecar::SidecarSupervisor::new(
                app.handle().clone(),
                resource_directory,
                data_directory.clone(),
            );
            let workspace_lock =
                workspace_lock::WorkspaceLock::load(&data_directory, supervisor.clone())?;
            if workspace_lock.status().state == models::WorkspaceLockState::Unlocked {
                let _ = supervisor.start();
            }
            let window_preferences = Arc::new(window_preferences::WindowPreferencesStore::load(
                &data_directory,
            )?);
            let startup_preferences = window_preferences.get();
            app.manage(app_updates::AppUpdateState::default());
            app.manage(HostState::new(
                supervisor,
                workspace_lock,
                window_preferences,
            ));
            tray::install(app)?;

            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                lifecycle::handle_deep_links(
                    &deep_link_handle,
                    event.urls().iter().map(ToString::to_string),
                );
            });

            // Password-gated profiles start after verification. Ordinary profiles have no
            // workspace lock and open directly.
            if let Some(window) = app.get_webview_window("main") {
                commands::apply_window_preferences(&window, &startup_preferences)?;
            }
            let headless_test = std::env::var_os("CUPCAKE_TEST_DATA_DIR").is_some()
                && std::env::var("CUPCAKE_TEST_HEADLESS").ok().as_deref() == Some("1");
            if headless_test {
                commands::show_main(app.handle());
            } else {
                match startup_preferences.startup_behavior {
                    window_preferences::StartupBehavior::Open => commands::show_main(app.handle()),
                    window_preferences::StartupBehavior::Minimized => {
                        commands::show_main(app.handle());
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.minimize();
                        }
                    }
                    window_preferences::StartupBehavior::Tray => {}
                }
            }
            Ok(())
        })
        .on_window_event(lifecycle::handle_window_event)
        .build(tauri::generate_context!())
        .expect("failed to build the Cupcake Chat desktop host");

    app.run(|app, event| lifecycle::handle_run_event(app, &event));
}
