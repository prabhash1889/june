mod agent_runner;
mod dictation;
mod diagnostics;
mod fsutil;
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
                // The scheduler now also starts voice-queued missions (4.10), so it
                // needs the same runner the resume path uses.
                let runner = app.state::<missions::MissionRunner>().inner().clone();
                scheduler::start(app.handle().clone(), session.clone(), runner.clone());
                // A mission left `active` by a previous app session resumes here
                // (improvement-5 P2 5.2) - the runner outlives every webview now.
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

            // Push-to-talk (Phase 4) + quick-capture (improvement-6 4.5): the two real
            // global hold-to-talk hotkeys. The plugin's Pressed/Released states give
            // true hold semantics a terminal can't - the webview starts capturing on
            // <kind>://down and transcribes on <kind>://up for each chord.
            #[cfg(desktop)]
            register_hotkeys(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            settings::save_automations,
            keychain::set_api_key,
            keychain::has_api_key,
            keychain::delete_api_key,
            logf::log_message,
            stt::transcribe,
            tts::synthesize,
            tts::cancel_synthesis,
            dictation::inject_text,
            dictation::append_inbox,
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
            missions::set_mission_paused,
            missions::mission_paused,
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

/// The two live global chords, parsed, shared between the plugin's one handler
/// closure and `apply_hotkeys` (improvement-6 4.5). The handler compares the fired
/// shortcut against these to route it to the PTT or the quick-capture event stream;
/// `apply_hotkeys` rewrites them when settings change. `.0` is PTT, `.1` is capture
/// (None when quick capture is off or failed to register).
#[cfg(desktop)]
type Chords = std::sync::Arc<
    std::sync::Mutex<(
        Option<tauri_plugin_global_shortcut::Shortcut>,
        Option<tauri_plugin_global_shortcut::Shortcut>,
    )>,
>;

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

/// The user's configured quick-capture chord (settings `captureHotkey`,
/// improvement-6 4.5). Empty/unset -> quick capture is off (no second shortcut is
/// registered), unlike PTT which always falls back to a default.
#[cfg(desktop)]
fn capture_hotkey(app: &tauri::AppHandle) -> String {
    settings::read_settings(app)
        .get("captureHotkey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// (Re-)registers both global chords - PTT and the optional quick-capture chord -
/// and stores their parsed forms in `chords` for the handler to dispatch on. PTT
/// never dies: on any failure the default chord is restored. Quick capture is
/// optional and skipped when unset or when it collides with PTT (PTT wins - a jot
/// key that stole push-to-talk is worse than no jot key). Each outcome is broadcast
/// as `ptt://status` / `capture://status` for the Activation settings cards.
#[cfg(desktop)]
fn apply_hotkeys(app: &tauri::AppHandle, chords: &Chords) {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    // Parse `s` then register it, returning the parsed Shortcut so the handler can
    // compare against it. A parse failure surfaces the same way as a register clash.
    let register = |s: &str| -> Result<Shortcut, String> {
        let sc: Shortcut = s.parse().map_err(|e| format!("{e}"))?;
        app.global_shortcut()
            .register(sc)
            .map(|()| sc)
            .map_err(|e| format!("{e}"))
    };

    let ptt = ptt_hotkey(app);
    let capture = capture_hotkey(app);
    let _ = app.global_shortcut().unregister_all();

    // PTT: never allowed to silently die - restore the default chord on any failure.
    let (ptt_shortcut, ptt_str, ptt_error) = match register(&ptt) {
        Ok(sc) => (Some(sc), ptt.clone(), None),
        Err(e) => (
            register(DEFAULT_PTT).ok(),
            DEFAULT_PTT.to_string(),
            Some(format!(
                "Couldn't register \"{ptt}\" ({e}) - push to talk stays on the default chord."
            )),
        ),
    };
    let _ = app.emit(
        "ptt://status",
        serde_json::json!({ "ok": ptt_error.is_none(), "hotkey": ptt_str, "error": ptt_error }),
    );

    // Quick capture (4.5): optional. Off when unset; refused when it collides with
    // the effective PTT chord so push-to-talk is never shadowed.
    let mut capture_shortcut: Option<Shortcut> = None;
    if !capture.is_empty() {
        let (ok, error) = if capture.eq_ignore_ascii_case(&ptt_str) {
            (
                false,
                Some("Quick-capture hotkey matches push-to-talk - pick a different chord.".to_string()),
            )
        } else {
            match register(&capture) {
                Ok(sc) => {
                    capture_shortcut = Some(sc);
                    (true, None)
                }
                Err(e) => (
                    false,
                    Some(format!(
                        "Couldn't register \"{capture}\" ({e}) - quick capture is off until you pick a free chord."
                    )),
                ),
            }
        };
        let _ = app.emit(
            "capture://status",
            serde_json::json!({ "ok": ok, "hotkey": capture, "error": error }),
        );
    }

    *chords.lock().unwrap() = (ptt_shortcut, capture_shortcut);
}

/// Registers the global hotkeys and bridges each chord's Pressed/Released edges to
/// the webview: PTT as `ptt://down` / `ptt://up`, quick capture (4.5) as
/// `capture://down` / `capture://up`. The chords come from settings and re-register
/// live when a settings write changes either one - the scheduler's out-of-band
/// `settings://changed` broadcasts arrive here too, so a voice-created settings edit
/// is picked up as well.
#[cfg(desktop)]
fn register_hotkeys(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{Emitter, Listener};
    use tauri_plugin_global_shortcut::ShortcutState;

    let chords: Chords = std::sync::Arc::new(std::sync::Mutex::new((None, None)));

    // The one handler dispatches by which registered chord fired (the fired shortcut
    // is compared against the two stored chords), so PTT and quick capture share a
    // single global-shortcut plugin.
    let chords_h = chords.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let kind = {
                    let c = chords_h.lock().unwrap();
                    if c.0.as_ref() == Some(shortcut) {
                        "ptt"
                    } else if c.1.as_ref() == Some(shortcut) {
                        "capture"
                    } else {
                        return; // a stale registration edge; ignore
                    }
                };
                let pressed = matches!(event.state(), ShortcutState::Pressed);
                // 7.10: arm/disarm the inject_text gate on the PTT edges so dictation
                // injection is only permitted during a real push-to-talk session.
                if kind == "ptt" {
                    dictation::note_ptt_edge(pressed);
                }
                let name = format!("{kind}://{}", if pressed { "down" } else { "up" });
                let _ = app.emit(&name, ());
            })
            .build(),
    )?;
    apply_hotkeys(app, &chords);

    let handle = app.clone();
    let chords_l = chords.clone();
    let last = std::sync::Mutex::new((ptt_hotkey(app), capture_hotkey(app)));
    app.listen("settings://changed", move |_| {
        let want = (ptt_hotkey(&handle), capture_hotkey(&handle));
        let mut cur = last.lock().unwrap();
        if *cur != want {
            *cur = want.clone();
            apply_hotkeys(&handle, &chords_l);
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
