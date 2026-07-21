// The run + audit ledgers, carved out of agent_runner.rs (improvement-8 2.3): the
// runner was doing resident lifecycle AND audit AND run-ledger accounting in one
// ~1800-line file. These pieces are mechanically separable - a pure record
// builder plus best-effort appends to <app_data_dir>/{audit,june-runs}.jsonl - so
// they get their own home and their own unit tests, and the runner shrinks to
// lifecycle + dispatch.

use std::io::Write;

use chrono::Local;
use tauri::{AppHandle, Emitter, Manager};

/// Roll `audit.jsonl` to `audit.jsonl.1` once it passes this size (B4.5), so the
/// tray resident's audit trail can't grow without bound.
const MAX_AUDIT_BYTES: u64 = 5 * 1024 * 1024;

/// Roll `june-runs.jsonl` at this size, mirroring the audit log's rotation (P1.3).
const MAX_RUNS_BYTES: u64 = 2 * 1024 * 1024;

/// Append one already-redacted, turn-stamped audit record (a `{"t":"audit",...}`
/// line from serve.ts) to `<app_data_dir>/audit.jsonl` (10.7). Best-effort: a
/// failed audit write must never break a turn, but it is the record phases 17-19
/// rely on, so failures are logged to stderr.
pub(crate) fn append_audit(app: &AppHandle, entry: &serde_json::Value) {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            crate::logf::log(app, &format!("[audit] no app data dir: {e}"));
            return;
        }
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("audit.jsonl");
    // Cap the audit log (B4.5): once it passes the size cap, roll it to
    // audit.jsonl.1 (replacing any prior roll) so a long-lived tray resident can't
    // grow it without bound. One generation of history is kept - plenty for the
    // "reviewable audit trail" the exit criterion names, without unbounded disk.
    crate::fsutil::rotate_if_larger(&path, MAX_AUDIT_BYTES);
    let line = entry.to_string();
    let write = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = write {
        crate::logf::log(app, &format!("[audit] could not write {}: {e}", path.display()));
    }
}

/// Cap a string to `max` chars (adding an ellipsis), so a long prompt/reply can't
/// bloat one ledger line. Char-based so it never splits a UTF-8 sequence.
pub(crate) fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Build one run-ledger record (P1.3), redacting prompt/reply to a length marker
/// under any on-device privacy mode so a headless run's content never lands on
/// disk (mirrors the audit redaction, policy.ts); standard mode keeps the text,
/// capped so one line can't bloat. Per-run token/cost (2.6) rides verbatim under
/// every mode - tokens aren't content. Pure, so both privacy modes are unit-tested
/// without touching the filesystem or app state (2.9).
#[allow(clippy::too_many_arguments)]
fn build_run_record(
    on_device: bool,
    id: u64,
    source: &str,
    prompt: &str,
    started: &str,
    ended: &str,
    reply: &str,
    is_error: bool,
    blocked: &[String],
    usage: Option<&serde_json::Value>,
) -> serde_json::Value {
    let redact = |s: &str| -> String {
        if on_device {
            format!("[redacted {} chars]", s.chars().count())
        } else {
            cap_chars(s, 2000)
        }
    };
    let mut record = serde_json::json!({
        "id": id,
        "source": source,
        "prompt": redact(prompt),
        "started": started,
        "ended": ended,
        "reply": redact(reply),
        "isError": is_error,
        "blocked": blocked,
    });
    if let Some(u) = usage {
        record["usage"] = u.clone();
    }
    record
}

/// Append one record to the run ledger (improvement-5 P1.3): what one unattended
/// run did, to `<app_data_dir>/june-runs.jsonl`, read back by the Runs tab. The
/// prompt/reply text is redacted to a length marker under any on-device privacy
/// mode (mirroring the audit redaction, policy.ts), so a headless run's content
/// never lands on disk when the user asked June to keep things local. Best-effort:
/// a failed ledger write must never break the run. Rotates one generation like the
/// audit log so a long-lived resident can't grow it without bound.
#[allow(clippy::too_many_arguments)]
pub(crate) fn append_run(
    app: &AppHandle,
    id: u64,
    source: &str,
    prompt: &str,
    started: &str,
    reply: &str,
    is_error: bool,
    blocked: &[String],
    usage: Option<&serde_json::Value>,
) {
    let on_device = matches!(
        crate::settings::read_settings(app).get("privacyMode").and_then(|v| v.as_str()),
        Some("local-voice") | Some("strict-offline")
    );
    let ended = Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
    let record = build_run_record(on_device, id, source, prompt, started, &ended, reply, is_error, blocked, usage);
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("june-runs.jsonl");
    crate::fsutil::rotate_if_larger(&path, MAX_RUNS_BYTES);
    let line = record.to_string();
    let write = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = write {
        crate::logf::log(app, &format!("[runs] could not write {}: {e}", path.display()));
    }
    // Wake the Runs tab (2.4): it was manual-refresh only, so an unattended run's
    // result appeared only if the user happened to hit Refresh. Best-effort - a
    // dropped event just means the next open/refresh catches up.
    let _ = app.emit("runs://updated", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    // Run-ledger redaction (2.9): the "on-device prompts never land on disk" rule was
    // uncovered. build_run_record is the pure record builder; pin both privacy modes.
    #[test]
    fn ledger_record_redacts_content_on_device() {
        let rec = build_run_record(
            true, // on-device (local-voice / strict-offline)
            42,
            "schedule: Briefing",
            "my secret prompt",
            "2026-07-21T09:00:00",
            "2026-07-21T09:00:03",
            "the secret reply",
            false,
            &[],
            None,
        );
        // Neither the prompt nor the reply text survives to disk - only a length marker.
        assert_eq!(rec["prompt"], "[redacted 16 chars]");
        assert_eq!(rec["reply"], "[redacted 16 chars]");
        assert!(!rec.to_string().contains("secret"));
        // Non-content fields are kept verbatim so the Runs tab still shows the run.
        assert_eq!(rec["source"], "schedule: Briefing");
        assert_eq!(rec["id"].as_u64(), Some(42));
    }

    #[test]
    fn ledger_record_keeps_content_under_standard_mode() {
        let rec = build_run_record(
            false, // standard mode
            1,
            "schedule: Briefing",
            "my prompt",
            "2026-07-21T09:00:00",
            "2026-07-21T09:00:03",
            "my reply",
            true,
            &["add_schedule".to_string()],
            None,
        );
        assert_eq!(rec["prompt"], "my prompt");
        assert_eq!(rec["reply"], "my reply");
        assert_eq!(rec["isError"], true);
        assert_eq!(rec["blocked"][0], "add_schedule");
    }

    #[test]
    fn ledger_record_caps_long_text_but_still_redacts_it_on_device() {
        let long = "x".repeat(5000);
        let standard = build_run_record(false, 1, "s", &long, "t0", "t1", &long, false, &[], None);
        // Standard mode caps at 2000 chars + the ellipsis marker, never the full 5000.
        assert_eq!(standard["prompt"].as_str().unwrap().chars().count(), 2001);
        let on_device = build_run_record(true, 1, "s", &long, "t0", "t1", &long, false, &[], None);
        assert_eq!(on_device["prompt"], "[redacted 5000 chars]");
    }

    #[test]
    fn ledger_record_rides_usage_verbatim_under_every_mode() {
        let usage = serde_json::json!({ "inputTokens": 100, "outputTokens": 20, "costUsd": 0.01 });
        for on_device in [false, true] {
            let rec = build_run_record(on_device, 1, "s", "p", "t0", "t1", "r", false, &[], Some(&usage));
            // Tokens aren't content, so they're recorded even when prompt/reply are redacted.
            assert_eq!(rec["usage"]["inputTokens"].as_u64(), Some(100));
            assert_eq!(rec["usage"]["costUsd"].as_f64(), Some(0.01));
        }
    }
}
