mod agent_runner;
mod dictation;
mod diagnostics;
mod http;
mod keychain;
mod logf;
mod missions;
mod scheduler;
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
        // OS notifications for unattended runs (Phase 18.1/18.2). Called from Rust
        // only (the scheduler), so no JS capability is needed.
        .plugin(tauri_plugin_notification::init())
        // The live agent turn's approval channel, shared by the run loop and the
        // resolve/pending commands (Phase 6 approval round-trip).
        .manage(agent_runner::AgentSession::default())
        .manage(missions::MissionRunner::default())
        .setup(|app| {
            // Autonomy (Phase 18): a background thread fires due scheduled runs and
            // file-triggers as unattended agent turns. The session is `.manage`d
            // above, so the state is available here.
            {
                use tauri::Manager;
                let session = app.state::<agent_runner::AgentSession>().inner().clone();
                scheduler::start(app.handle().clone(), session.clone());
                // A mission left `active` by a previous app session resumes here
                // (improvement-5 P2 5.2) - the runner outlives every webview now.
                let runner = app.state::<missions::MissionRunner>().inner().clone();
                missions::resume(app.handle().clone(), session, runner);
            }
            // Tray presence (Phase 0 exit criterion): an icon in the system tray for the
            // whole app lifetime, independent of any window being open. Left-click
            // brings the widget to front; right-click offers the full window and quit.
            let show_widget = MenuItem::with_id(app, "show-widget", "Show widget", true, None::<&str>)?;
            let open_full = MenuItem::with_id(app, "open-app", "Open full window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit June", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_widget, &open_full, &quit])?;
            // Build the tray WITHOUT unwrapping the bundle icon (1.12): a missing
            // icon must not panic the whole app at startup. The tray still works
            // (menu + clicks); it just shows the OS default glyph.
            let mut tray = TrayIconBuilder::new().tooltip("June");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.menu(&menu)
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
            logf::log_message,
            stt::transcribe,
            tts::synthesize,
            dictation::inject_text,
            diagnostics::bridge_health,
            diagnostics::test_brain,
            agent_runner::run_agent,
            agent_runner::cancel_agent,
            agent_runner::resolve_approval,
            agent_runner::pending_approval,
            agent_runner::session_events,
            agent_runner::new_conversation,
            agent_runner::read_memory,
            agent_runner::write_memory,
            agent_runner::read_lessons,
            agent_runner::write_lessons,
            agent_runner::read_mission,
            agent_runner::write_mission,
            agent_runner::read_runs,
            missions::start_mission,
            missions::stop_mission,
            scheduler::run_schedule_now,
            agent_runner::record_latency,
            agent_runner::latency_samples,
            agent_runner::usage_total,
            agent_runner::record_voice_health,
            agent_runner::voice_health,
            show_app,
            set_widget_expanded,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Tear down the resident serve.ts process tree on quit (1.10) so the app
            // never leaves a live node/tsx tree (with open MCP stdio clients) behind
            // after it exits - the tray Quit and window-close both route through here.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                if let Some(session) = app_handle.try_state::<agent_runner::AgentSession>() {
                    session.shutdown();
                }
            }
        });
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

/// Logical (CSS px) window size for a widget face. Expanded height is
/// content-driven (improvement-5 P2 6.11): the shell reports how tall the card
/// needs to be; clamped so a runaway measure can't blow the window up or shrink
/// it below a usable card. The collapsed tile hugs the orb (64 + 12px drag
/// frame each side). Must match the CSS layout.
fn widget_size(expanded: bool, height: Option<f64>) -> (f64, f64) {
    if expanded {
        (340.0, height.unwrap_or(440.0).clamp(172.0, 440.0))
    } else {
        (88.0, 88.0)
    }
}

/// Resizes the widget window between its collapsed (bare orb) and expanded
/// (card) faces, keeping the bottom-right corner anchored so a corner-parked
/// widget grows into the screen. Done in one Rust command instead of a chain of
/// JS round-trips (scale/pos/size/setSize/setPosition) so the transition doesn't
/// visibly jump. The result is clamped to the widget's own monitor, which also
/// keeps multi-monitor (negative-coordinate) setups on-screen.
#[tauri::command]
fn set_widget_expanded(window: tauri::WebviewWindow, expanded: bool, height: Option<f64>) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize};
    let (w, h) = widget_size(expanded, height);
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
        // Explicitly dark (improvement-5 P2 6.9): the content is always dark, so
        // the titlebar must not follow a light OS theme.
        let _ = WebviewWindowBuilder::new(&app, "app", WebviewUrl::default())
            .title("June")
            .inner_size(900.0, 640.0)
            .min_inner_size(560.0, 420.0)
            .theme(Some(tauri::Theme::Dark))
            .build();
    });
}

#[tauri::command]
async fn show_app(app: tauri::AppHandle) -> Result<(), String> {
    open_full_window(&app);
    Ok(())
}

/// The default push-to-talk chord, in global-shortcut syntax.
#[cfg(desktop)]
const DEFAULT_PTT: &str = "ctrl+shift+space";

/// The user's configured push-to-talk chord (settings `pttHotkey`,
/// improvement-5 P2 6.6), falling back to the default when unset or blank.
#[cfg(desktop)]
fn ptt_hotkey(app: &tauri::AppHandle) -> String {
    settings::read_settings(app)
        .get("pttHotkey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PTT)
        .to_string()
}

/// (Re-)registers `hotkey` as the one global PTT chord. On failure (unparseable,
/// or taken by another app) the default chord is restored so push-to-talk never
/// silently dies, and the outcome is broadcast as `ptt://status` for the
/// Activation settings card.
#[cfg(desktop)]
fn apply_ptt_hotkey(app: &tauri::AppHandle, hotkey: &str) {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let error = match shortcuts.register(hotkey) {
        Ok(()) => None,
        Err(e) => {
            let _ = shortcuts.register(DEFAULT_PTT);
            Some(format!(
                "Couldn't register \"{hotkey}\" ({e}) - push to talk stays on the default chord."
            ))
        }
    };
    let _ = app.emit(
        "ptt://status",
        serde_json::json!({ "ok": error.is_none(), "hotkey": hotkey, "error": error }),
    );
}

/// Registers the push-to-talk hotkey and bridges its Pressed/Released edges to
/// the webview as `ptt://down` / `ptt://up` events. The chord comes from
/// settings (6.6) and re-registers live when a settings write changes it - the
/// scheduler's out-of-band `settings://changed` broadcasts arrive here too, so a
/// voice-created settings edit is picked up as well.
#[cfg(desktop)]
fn register_push_to_talk(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{Emitter, Listener};
    use tauri_plugin_global_shortcut::ShortcutState;

    // June registers exactly one global shortcut - the PTT chord - so the
    // handler needs no per-shortcut dispatch.
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, _shortcut, event| {
                let name = match event.state() {
                    ShortcutState::Pressed => "ptt://down",
                    ShortcutState::Released => "ptt://up",
                };
                let _ = app.emit(name, ());
            })
            .build(),
    )?;
    apply_ptt_hotkey(app, &ptt_hotkey(app));

    let current = std::sync::Mutex::new(ptt_hotkey(app));
    let handle = app.clone();
    app.listen("settings://changed", move |_| {
        let want = ptt_hotkey(&handle);
        let mut cur = current.lock().unwrap();
        if *cur != want {
            *cur = want.clone();
            apply_ptt_hotkey(&handle, &want);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::widget_size;

    #[test]
    fn widget_size_clamps_expanded_height_and_defaults() {
        assert_eq!(widget_size(false, Some(400.0)), (88.0, 88.0));
        assert_eq!(widget_size(true, None), (340.0, 440.0));
        assert_eq!(widget_size(true, Some(300.0)), (340.0, 300.0));
        assert_eq!(widget_size(true, Some(20.0)), (340.0, 172.0));
        assert_eq!(widget_size(true, Some(9000.0)), (340.0, 440.0));
    }
}
