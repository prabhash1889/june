mod keychain;
mod settings;

use tauri::tray::TrayIconBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered first: when a second launch is attempted, this callback runs in the
    // already-running process, so we focus the existing window instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
        // Restores the window's last size/position/maximized state on launch.
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .setup(|app| {
            // Tray presence (Phase 0 exit criterion): an icon in the system tray for the
            // whole app lifetime, independent of any window being open.
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("June")
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            keychain::set_api_key,
            keychain::has_api_key,
            keychain::delete_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
