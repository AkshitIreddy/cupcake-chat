use crate::commands::{emit_window_state, show_main};
use crate::models::{DeepLinkPayload, DEEP_LINK_EVENT_NAME};
use crate::state::HostState;
use crate::url_policy::normalize_deep_link;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

pub fn handle_single_instance(app: &AppHandle, arguments: Vec<String>) {
    let urls = arguments
        .into_iter()
        .filter_map(|argument| normalize_deep_link(&argument).ok())
        .collect::<Vec<_>>();
    show_main(app);
    if !urls.is_empty() {
        let _ = app.emit(DEEP_LINK_EVENT_NAME, DeepLinkPayload { urls });
    }
}

pub fn handle_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    let urls = urls
        .into_iter()
        .filter_map(|url| normalize_deep_link(&url).ok())
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return;
    }
    show_main(app);
    let _ = app.emit(DEEP_LINK_EVENT_NAME, DeepLinkPayload { urls });
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
            api.prevent_close();
            let _ = window.hide();
        }
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                emit_window_state(&webview);
            }
        }
        _ => {}
    }
}

pub fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let state = app.state::<HostState>();
            state.supervisor.stop();
            state.files.clear();
        }
        _ => {}
    }
}
