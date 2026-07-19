mod agent_runner;
mod diagnostics;
mod keychain;
mod settings;
mod stt;
mod tts;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered first: when a second launch is attempted, this callback runs in the
    // already-running process, so we focus the existing window instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_widget(app);
        }));
        // Restores window positions on launch. POSITION only: the widget's size is
        // owned by its expand/collapse logic (set_widget_expanded), and restoring a
        // stale expanded size would leave a big invisible window around a small orb.
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        );
    }

    builder
        // The live agent turn's approval channel, shared by the run loop and the
        // resolve/pending commands (Phase 6 approval round-trip).
        .manage(agent_runner::AgentSession::default())
        .setup(|app| {
            // Tray presence (Phase 0 exit criterion): an icon in the system tray for the
            // whole app lifetime, independent of any window being open. Left-click
            // brings the widget to front; right-click offers the full window and quit.
            let show_widget = MenuItem::with_id(app, "show-widget", "Show widget", true, None::<&str>)?;
            let open_full = MenuItem::with_id(app, "open-app", "Open full window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit June", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_widget, &open_full, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("June")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show-widget" => focus_widget(app),
                    "open-app" => open_full_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_widget(tray.app_handle());
                    }
                })
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
            tts::synthesize,
            diagnostics::bridge_health,
            diagnostics::test_brain,
            agent_runner::run_agent,
            agent_runner::resolve_approval,
            agent_runner::pending_approval,
            agent_runner::session_events,
            show_app,
            set_widget_expanded,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Brings the always-on widget to the front (tray click / tray menu).
fn focus_widget(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Resizes the widget window between its collapsed (bare orb) and expanded
/// (card) faces, keeping the bottom-right corner anchored so a corner-parked
/// widget grows into the screen. Done in one Rust command instead of a chain of
/// JS round-trips (scale/pos/size/setSize/setPosition) so the transition doesn't
/// visibly jump. The result is clamped to the widget's own monitor, which also
/// keeps multi-monitor (negative-coordinate) setups on-screen.
#[tauri::command]
fn set_widget_expanded(window: tauri::WebviewWindow, expanded: bool) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize};
    // Logical (CSS px) sizes for the two faces; must match the CSS layout. The
    // collapsed tile hugs the orb (64 + 12px drag frame each side): the window
    // is opaque now, so no empty dark slab around the orb.
    let (w, h) = if expanded { (340.0, 440.0) } else { (88.0, 88.0) };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    // set_size sets the INNER size, but the opaque window's outer rect includes
    // Windows' invisible frame. Anchor with outer sizes on both ends, otherwise
    // every expand/collapse drifts the window by the frame delta.
    let frame_w = outer.width.saturating_sub(inner.width) as i32;
    let frame_h = outer.height.saturating_sub(inner.height) as i32;
    let new_w = (w * scale).round() as u32;
    let new_h = (h * scale).round() as u32;
    let mut x = pos.x + outer.width as i32 - (new_w as i32 + frame_w);
    let mut y = pos.y + outer.height as i32 - (new_h as i32 + frame_h);
    if let Ok(Some(monitor)) = window.current_monitor() {
        x = x.max(monitor.position().x);
        y = y.max(monitor.position().y);
    }
    window
        .set_size(PhysicalSize::new(new_w, new_h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens (or focuses, if already open) the full application window. June's
/// default face is the always-on floating widget (`main`); the full window -
/// conversation history, approvals, and later settings/diagnostics - is opened
/// on demand from the widget or the tray, and shares the same agent session
/// (PLAN.md Phase 6: "one app with two faces, sharing a single agent core").
///
/// Safe to call from any thread: the build is posted to the main thread's event
/// loop. Building the webview window synchronously inside a command handler
/// deadlocks on Windows - the new webview never navigates (a stuck blank white
/// window) and the invoke promise never resolves.
fn open_full_window(app: &tauri::AppHandle) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(window) = app.get_webview_window("app") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        // Same bundle as the widget; the frontend picks its face by window label.
        let _ = WebviewWindowBuilder::new(&app, "app", WebviewUrl::default())
            .title("June")
            .inner_size(900.0, 640.0)
            .min_inner_size(560.0, 420.0)
            .build();
    });
}

#[tauri::command]
async fn show_app(app: tauri::AppHandle) -> Result<(), String> {
    open_full_window(&app);
    Ok(())
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
