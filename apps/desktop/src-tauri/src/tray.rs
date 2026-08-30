use crate::commands::show_main;
use crate::models::DESKTOP_COMMAND_EVENT_NAME;
use crate::state::HostState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, Emitter, Manager};

pub fn install(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open CUPCAKEAGI", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "chat.new", "New chat", true, None::<&str>)?;
    let preferences = MenuItem::with_id(app, "app.preferences", "Preferences", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "app.about", "About CUPCAKEAGI", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_chat,
            &preferences,
            &separator,
            &about,
            &separator_two,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("CUPCAKEAGI")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => {
                let state = app.state::<HostState>();
                state.supervisor.stop();
                state.files.clear();
                app.exit(0);
            }
            command @ ("chat.new" | "app.preferences" | "app.about") => {
                show_main(app);
                let _ = app.emit(DESKTOP_COMMAND_EVENT_NAME, command);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
