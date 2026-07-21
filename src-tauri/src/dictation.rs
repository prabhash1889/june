// System-wide dictation injection (PLAN.md Phase 15.4). The webview captures the
// user's speech, transcribes it, cleans it (src/lib/transcript.ts), and hands the
// finished text here to be typed into whatever app currently has focus.
//
// SAFETY (the rule improvement-2 lacked): this is only ever the direct result of a
// user-held push-to-talk press. It is NOT an agent tool - the model can never call
// it - so it stays on the right side of PLAN §8 ("OS-wide actions stay
// unavailable"): the user is the actor, June is only the keyboard. The widget shows
// a visible "Dictating…" indicator whenever a dictation capture is live.
//
// enigo's SendInput targets the foreground window. June's widget is a small
// always-on-top orb that never takes focus on a PTT press, so the text lands in the
// user's target app (Notepad, a browser field, ...), not in June.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use enigo::{Enigo, Keyboard, Settings};
use tauri::{AppHandle, Manager};

// 7.10: `inject_text` types into whatever app has OS focus and is invokable by ANY
// webview script, so "only after a push-to-talk press" must be ENFORCED, not left as
// convention. `note_ptt_edge` (called from the global-shortcut handler in lib.rs)
// opens a window on PTT down and shortens it to a short grace on PTT up; injection is
// refused outside that window. The grace exists because the real dictation inject
// happens AFTER the key is released (STT + transcript cleaning run post-release).
static INJECT_DEADLINE_MS: AtomicU64 = AtomicU64::new(0);

/// Generous cap while the PTT key is held (a real hold is far shorter).
const HELD_WINDOW_MS: u64 = 5 * 60 * 1000;
/// Grace after release covering async STT (20s timeout) + cleaning + the type call.
const RELEASE_GRACE_MS: u64 = 30 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record a PTT chord edge. `down` opens the injection window; a release starts the
/// grace countdown. Only the PTT chord calls this - quick capture (4.5) never injects.
pub fn note_ptt_edge(down: bool) {
    let window = if down { HELD_WINDOW_MS } else { RELEASE_GRACE_MS };
    INJECT_DEADLINE_MS.store(now_ms().saturating_add(window), Ordering::SeqCst);
}

fn injection_permitted(now: u64) -> bool {
    now <= INJECT_DEADLINE_MS.load(Ordering::SeqCst)
}

/// Type `text` into the currently focused application. Returns a human-readable
/// error (surfaced in the widget) if the OS input path is unavailable. An empty
/// string is a no-op success - a silent dictation clip should not raise an error.
/// Refused outside a live PTT session (7.10) so a rogue webview script can't type
/// into the focused app at an arbitrary time.
#[tauri::command]
pub fn inject_text(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    if !injection_permitted(now_ms()) {
        return Err("Dictation only works during a push-to-talk press.".into());
    }
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Could not access the keyboard for dictation: {e}"))?;
    enigo
        .text(&text)
        .map_err(|e| format!("Could not type the dictated text: {e}"))
}

/// Quick-capture voice inbox (improvement-6 4.5): append one timestamped line to
/// `<app_data_dir>/june-inbox.md` - the same host-owned, contained-path pattern as
/// june-memory.md (the model never picks the path; there is no brain in this loop).
/// A blank clip is a no-op success, matching inject_text: a silent capture should
/// not raise an error. The file (and its dir) are created on first jot.
#[tauri::command]
pub fn append_inbox(app: AppHandle, text: String) -> Result<(), String> {
    let line = text.trim();
    if line.is_empty() {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("june-inbox.md");
    // Local time to match the user's day (the scheduler reads NaiveDateTime as
    // local too); one bullet per jot so the inbox reads as a flat checklist.
    let stamp = Local::now().format("%Y-%m-%d %H:%M");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "- [{stamp}] {line}").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injection_gated_on_a_live_ptt_session() {
        // No PTT press -> refused (the initial 0 deadline is always in the past).
        INJECT_DEADLINE_MS.store(0, Ordering::SeqCst);
        assert!(!injection_permitted(now_ms()));

        // A held press opens the window.
        note_ptt_edge(true);
        assert!(injection_permitted(now_ms()));

        // Release keeps a grace window open (STT + inject run after the key is up)...
        note_ptt_edge(false);
        assert!(injection_permitted(now_ms()));
        // ...but only briefly: past the grace, injection is refused again.
        assert!(!injection_permitted(now_ms() + RELEASE_GRACE_MS + 1));
    }
}
