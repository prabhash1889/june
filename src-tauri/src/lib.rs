mod agent_runner;
mod keychain;
mod settings;
mod stt;

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

            // Push-to-talk (Phase 4): a real global hold-to-talk hotkey. The plugin's
            // Pressed/Released states give true hold semantics a terminal can't - the
            // webview starts capturing on ptt://down and transcribes on ptt://up.
            #[cfg(desktop)]
            register_push_to_talk(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            keychain::set_api_key,
            keychain::has_api_key,
            keychain::delete_api_key,
            stt::transcribe,
            agent_runner::run_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Registers the Ctrl+Shift+Space push-to-talk hotkey and bridges its
/// Pressed/Released edges to the webview as `ptt://down` / `ptt://up` events.
///
/// ponytail: the chord is fixed for now; a user-configurable hotkey is a Phase 7
/// settings entry (PLAN.md §4 Activation).
#[cfg(desktop)]
fn register_push_to_talk(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let ptt = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    let ptt_for_handler = ptt;

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &ptt_for_handler {
                    let name = match event.state() {
                        ShortcutState::Pressed => "ptt://down",
                        ShortcutState::Released => "ptt://up",
                    };
                    let _ = app.emit(name, ());
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(ptt)?;
    Ok(())
}
