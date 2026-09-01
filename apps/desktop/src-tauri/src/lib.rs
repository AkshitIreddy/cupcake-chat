mod allowlist;
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

use crate::commands::*;
use crate::state::HostState;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
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
        .invoke_handler(tauri::generate_handler![
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
            window_is_maximized,
            window_minimize,
            window_start_dragging,
            window_toggle_maximize,
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
                data_directory,
            );
            app.manage(HostState::new(supervisor.clone()));
            tray::install(app)?;

            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                lifecycle::handle_deep_links(
                    &deep_link_handle,
                    event.urls().iter().map(ToString::to_string),
                );
            });

            // Missing staged binaries are a supported source-checkout state.
            // The status event reports the disabled/crashed boundary while the
            // UI remains available for diagnostics and packaging preparation.
            let _ = supervisor.start();
            commands::show_main(app.handle());
            Ok(())
        })
        .on_window_event(lifecycle::handle_window_event)
        .build(tauri::generate_context!())
        .expect("failed to build the CupcakeAI desktop host");

    app.run(|app, event| lifecycle::handle_run_event(app, &event));
}
