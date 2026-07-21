// A rotating file log for release builds (improvement-6 2.1). A windowed release
// build has no console, so every `eprintln!` on a failure path (audit, runs,
// mission, scheduler writes, and the resident serve.ts's own stderr) used to
// vanish - a failure on a user machine was undiagnosable. This routes those sites
// to `<app_data_dir>/june.log`, rotated one generation like the audit/run ledgers,
// and still mirrors to stderr in dev so a `tsx` terminal keeps its live output.

use std::io::Write;

use chrono::Local;
use tauri::{AppHandle, Manager};

/// Roll `june.log` to `june.log.1` once it passes this size, so a long-lived tray
/// resident can't grow it without bound. One generation is plenty for diagnosis.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Cap one renderer-forwarded log line so a runaway error message can't bloat a
/// single log entry.
const MAX_RENDERER_CHARS: usize = 2000;

fn log_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("june.log"))
}

/// Append one timestamped line to `<app_data_dir>/june.log`, rotating one
/// generation at the size cap. Mirrors to stderr in debug builds so a dev terminal
/// still sees it live. Best-effort: a failed log write must never break its caller
/// - this IS the failure-path logger, so it can only try.
pub fn log(app: &AppHandle, line: &str) {
    #[cfg(debug_assertions)]
    eprintln!("{line}");
    let Some(path) = log_path(app) else { return };
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let ts = Local::now().format("%Y-%m-%dT%H:%M:%S");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{ts} {line}"));
}

/// Forward a renderer-side error into the file log (2.2). The frontend's
/// ErrorBoundary and global `error`/`unhandledrejection` hooks call this so a
/// render throw that blanks the always-on-top widget leaves a trace instead of
/// just "June died". Length-capped; best-effort.
#[tauri::command]
pub fn log_message(app: AppHandle, message: String) {
    let capped: String = if message.chars().count() > MAX_RENDERER_CHARS {
        message.chars().take(MAX_RENDERER_CHARS).collect::<String>() + "…"
    } else {
        message
    };
    log(&app, &format!("[renderer] {capped}"));
}
