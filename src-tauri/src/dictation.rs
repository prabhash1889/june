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

use chrono::Local;
use enigo::{Enigo, Keyboard, Settings};
use tauri::{AppHandle, Manager};

/// Type `text` into the currently focused application. Returns a human-readable
/// error (surfaced in the widget) if the OS input path is unavailable. An empty
/// string is a no-op success - a silent dictation clip should not raise an error.
#[tauri::command]
pub fn inject_text(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
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
