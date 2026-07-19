// Feeds an accepted transcript to the agent core (PLAN.md Phase 4 exit:
// "transcription feed the agent"). Rather than re-implement the Node agent loop
// in Rust, this spawns the existing core through agent/run-once.ts and returns
// June's final reply - the core is reused verbatim, only the surface differs.
//
// Phase 5 adds streaming: run-once.ts emits per-token `{"t":"text"}` lines, so
// we read stdout line by line and re-emit each delta as an `agent://text` Tauri
// event, letting the webview speak sentence-by-sentence before the whole answer
// is generated.
//
// Phase 6 adds two things:
//   1. An interactive approval round-trip. run-once emits `{"t":"approval",...}`
//      when a gated (expensive/destructive) tool is proposed and blocks on its
//      stdin for a decision. We hold that stdin here so `resolve_approval` can
//      write the user's answer back - the gate still lives in June's execution
//      layer (PLAN.md §5), the brain can't bypass it, and Phases 4/5's
//      fail-closed stub is now a real approve/reject.
//   2. Full session broadcast. Every step (user message, tool use/result,
//      approval, final reply) is emitted as an `agent://*` event to ALL windows,
//      so the always-on widget and the on-demand full app render the same
//      session - a command started in one is inspectable/approvable in the other
//      (PLAN.md Phase 6 exit).
//
// ponytail: dev-time invocation via `npx tsx`, matching the Phase 1-5 harnesses;
// a bundled sidecar binary is Phase 9 hardening. Only one turn runs at a time
// (the widget owns the mic), so a single shared approval channel is enough.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

/// A gated tool call awaiting a human yes/no. Serialized straight to the UI as
/// the `agent://approval` payload; also stored so a window opened mid-approval
/// can seed itself via `pending_approval`.
#[derive(Clone, serde::Serialize)]
pub struct PendingApproval {
    turn: u64,
    id: u64,
    action: String,
    summary: String,
    cls: String,
}

/// The live agent turn's control channel. `stdin` is the running run-once
/// process's stdin (how a decision reaches the blocked gate), tagged with its
/// turn so a barged-in-on turn that finishes late can't clobber the channel of
/// the newer turn that replaced it; `pending` is the approval currently awaiting
/// an answer (or `None`). Shared `Arc`s so the blocking read loop and the
/// `resolve_approval` command touch the same state.
#[derive(Default, Clone)]
pub struct AgentSession {
    stdin: Arc<Mutex<Option<(u64, ChildStdin)>>>,
    pending: Arc<Mutex<Option<PendingApproval>>>,
    /// Recorded session events (`{name, payload}`), the source of truth a
    /// window opened mid-session replays via `session_events`. Text deltas are
    /// not recorded - the turn's `final` supersedes them and they would
    /// dominate the log.
    events: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Stamps every recorded event's `payload.seq` so the replaying window can
    /// deduplicate the overlap between replay and live delivery.
    seq: Arc<AtomicU64>,
}

/// ponytail: hard cap so a tray-resident session can't grow without bound;
/// the oldest events fall off first. Bump if long sessions truncate too soon.
const MAX_EVENTS: usize = 500;

/// Stamp `payload.seq`, append the event to the session log (capped), and
/// return the stamped payload for broadcasting.
fn record_event(
    events: &Mutex<Vec<serde_json::Value>>,
    seq: &AtomicU64,
    name: &str,
    mut payload: serde_json::Value,
) -> serde_json::Value {
    payload["seq"] = (seq.fetch_add(1, Ordering::Relaxed) + 1).into();
    let mut log = events.lock().unwrap();
    log.push(serde_json::json!({ "name": name, "payload": payload }));
    if log.len() > MAX_EVENTS {
        let excess = log.len() - MAX_EVENTS;
        log.drain(..excess);
    }
    payload
}

/// Record a session event and broadcast it to every window.
fn record(session: &AgentSession, app: &AppHandle, name: &str, payload: serde_json::Value) {
    let payload = record_event(&session.events, &session.seq, name, payload);
    let _ = app.emit(name, payload);
}

/// Absolute path to agent/run-once.ts, resolved from this crate at compile time
/// (`<repo>/src-tauri` -> `<repo>/agent/run-once.ts`).
fn run_once_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join("agent").join("run-once.ts"))
        .unwrap_or_else(|| PathBuf::from("agent/run-once.ts"))
}

/// Run one agent turn from the given transcript and return June's spoken-style
/// reply. Every step is broadcast as an `agent://*` event tagged with `turn` so
/// the surface can drop events from a turn that was barged in on. Errors come
/// back as `Err` so the UI can surface them instead of pretending success.
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    session: State<'_, AgentSession>,
    transcript: String,
    turn: u64,
) -> Result<String, String> {
    let transcript = transcript.trim().to_string();
    if transcript.is_empty() {
        return Err("Nothing to send: the transcript was empty.".to_string());
    }

    let script = run_once_script();
    let cwd = script
        .parent()
        .and_then(|agent_dir| agent_dir.parent())
        .map(|p| p.to_path_buf())
        .ok_or("Could not locate the June project root.")?;

    let session = session.inner().clone();

    // Mirror the user's message to any open window before June starts working.
    record(&session, &app, "agent://user", serde_json::json!({ "turn": turn, "text": transcript }));

    // Blocking child + line reads off the async runtime (Tauri has no tokio
    // "process" feature enabled). We emit each streamed line as it arrives.
    let app_task = app.clone();
    let session_task = session.clone();
    let (final_text, stderr) = tauri::async_runtime::spawn_blocking(move || {
        // On Windows `npx` is a .cmd shim that can't be exec'd directly, so go
        // through the shell. Elsewhere invoke npx directly.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg("npx");
            c
        } else {
            Command::new("npx")
        };
        let mut child = cmd
            .arg("tsx")
            .arg(&script)
            .arg(&transcript)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start the agent: {e}"))?;

        // Hold the child's stdin so `resolve_approval` can answer a gated call.
        if let Some(stdin) = child.stdin.take() {
            *session_task.stdin.lock().unwrap() = Some((turn, stdin));
        }
        let stdout = child
            .stdout
            .take()
            .ok_or("The agent produced no output stream.")?;

        // run-once.ts emits JSONL; forward each kind as an `agent://*` event.
        let mut final_text: Option<String> = None;
        for line in BufReader::new(stdout).lines() {
            let line = line.unwrap_or_default();
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            let str_at = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            match v.get("t").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(delta) = v.get("delta").and_then(|d| d.as_str()) {
                        let _ = app_task.emit(
                            "agent://text",
                            serde_json::json!({ "turn": turn, "delta": delta }),
                        );
                    }
                }
                Some("tool") => {
                    record(
                        &session_task,
                        &app_task,
                        "agent://tool",
                        serde_json::json!({ "turn": turn, "action": v.get("action"), "input": v.get("input") }),
                    );
                }
                Some("result") => {
                    record(
                        &session_task,
                        &app_task,
                        "agent://result",
                        serde_json::json!({ "turn": turn, "action": v.get("action"), "res": v.get("res"), "isError": v.get("isError") }),
                    );
                }
                Some("approval") => {
                    // Only the turn that still owns the decision channel may
                    // surface a prompt. A turn that was barged in on lost its
                    // stdin to the newer turn - its gate self-denies (closed
                    // channel), so showing its prompt would offer a decision
                    // that can never be delivered.
                    let owns_channel = matches!(
                        session_task.stdin.lock().unwrap().as_ref(),
                        Some((t, _)) if *t == turn
                    );
                    if owns_channel {
                        let pa = PendingApproval {
                            turn,
                            id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
                            action: str_at("action"),
                            summary: str_at("summary"),
                            cls: str_at("cls"),
                        };
                        *session_task.pending.lock().unwrap() = Some(pa.clone());
                        let _ = app_task.emit("agent://approval", pa);
                    }
                }
                Some("approval-expired") => {
                    // The gate timed out and denied; clear the dead prompt in
                    // every window so a late click can't look accepted.
                    let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                    let mut guard = session_task.pending.lock().unwrap();
                    if matches!(guard.as_ref(), Some(p) if p.turn == turn && p.id == id) {
                        *guard = None;
                        drop(guard);
                        let _ = app_task.emit(
                            "agent://approval-resolved",
                            serde_json::json!({ "turn": turn, "id": id, "decision": "deny" }),
                        );
                    }
                }
                Some("final") => {
                    final_text = Some(str_at("text"));
                }
                _ => {}
            }
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Agent process failed: {e}"))?;
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Ok::<_, String>((final_text, stderr))
    })
    .await
    .map_err(|e| format!("Agent task failed: {e}"))??;

    // The turn is over: drop the control channel and any dangling approval - but
    // only if they still belong to THIS turn. A barged-in-on turn finishes late,
    // after a newer turn may have installed its own channel; clearing here would
    // strand that newer turn's approval gate until its 120s deny timeout.
    {
        let mut guard = session.stdin.lock().unwrap();
        if matches!(guard.as_ref(), Some((t, _)) if *t == turn) {
            *guard = None;
        }
    }
    {
        let mut guard = session.pending.lock().unwrap();
        if matches!(guard.as_ref(), Some(p) if p.turn == turn) {
            *guard = None;
        }
    }

    match final_text {
        Some(text) => {
            record(
                &session,
                &app,
                "agent://final",
                serde_json::json!({ "turn": turn, "text": text, "isError": false }),
            );
            Ok(text)
        }
        None => {
            let msg = format!("The agent produced no reply. {}", stderr.trim());
            // Still emit a final so mirrored windows stop showing "working".
            record(
                &session,
                &app,
                "agent://final",
                serde_json::json!({ "turn": turn, "text": msg, "isError": true }),
            );
            Err(msg)
        }
    }
}

/// Answer the pending approval by writing a decision line to the running agent's
/// stdin, then broadcast the resolution so every window clears its prompt.
/// `decision` is "allow" or "deny" (anything else is treated as deny).
#[tauri::command]
pub fn resolve_approval(
    app: AppHandle,
    session: State<'_, AgentSession>,
    id: u64,
    decision: String,
) -> Result<(), String> {
    let decision = if decision == "allow" { "allow" } else { "deny" };
    // Validate against the pending approval before touching any stdin: a
    // decision for an approval that is no longer pending (expired, already
    // decided in the other window) must not reach the live turn's channel,
    // and the write must go to the pending approval's own turn - never to
    // whichever turn happens to hold the channel now.
    let turn = match session.pending.lock().unwrap().as_ref() {
        Some(p) if p.id == id => p.turn,
        _ => return Err("That approval is no longer pending.".to_string()),
    };

    {
        let mut guard = session.stdin.lock().unwrap();
        let stdin = match guard.as_mut() {
            Some((t, stdin)) if *t == turn => stdin,
            _ => return Err("That approval is no longer pending.".to_string()),
        };
        let line = format!("{}\n", serde_json::json!({ "approvalId": id, "decision": decision }));
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("Could not deliver the decision: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("Could not deliver the decision: {e}"))?;
    }
    *session.pending.lock().unwrap() = None;
    let _ = app.emit(
        "agent://approval-resolved",
        serde_json::json!({ "turn": turn, "id": id, "decision": decision }),
    );
    Ok(())
}

/// The approval currently awaiting a decision, if any. A full-app window opened
/// mid-approval calls this on mount so it can approve a command the widget
/// started before the window existed.
#[tauri::command]
pub fn pending_approval(session: State<'_, AgentSession>) -> Option<PendingApproval> {
    session.pending.lock().unwrap().clone()
}

/// The recorded session log, oldest first. A window opened mid-session replays
/// this before applying live events (deduplicated by each payload's `seq`), so
/// the full app always shows the conversation the widget drove (PLAN.md Phase
/// 6: "one app with two faces, sharing a single agent core").
#[tauri::command]
pub fn session_events(session: State<'_, AgentSession>) -> Vec<serde_json::Value> {
    session.events.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_event_stamps_monotonic_seq_and_caps_the_log() {
        let events = Mutex::new(Vec::new());
        let seq = AtomicU64::new(0);
        for i in 0..(MAX_EVENTS + 10) {
            let stamped = record_event(
                &events,
                &seq,
                "agent://user",
                serde_json::json!({ "turn": 1, "text": format!("m{i}") }),
            );
            assert_eq!(stamped["seq"].as_u64(), Some(i as u64 + 1));
        }
        let log = events.lock().unwrap();
        assert_eq!(log.len(), MAX_EVENTS);
        // Oldest fell off; the remaining log is contiguous and ends at the newest.
        assert_eq!(log[0]["payload"]["seq"].as_u64(), Some(11));
        assert_eq!(
            log[MAX_EVENTS - 1]["payload"]["seq"].as_u64(),
            Some(MAX_EVENTS as u64 + 10)
        );
    }
}
