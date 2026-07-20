// Drives the agent core (PLAN.md Phase 4 exit: "transcription feed the agent").
//
// Phase 11.1 replaces the per-turn spawn with a RESIDENT process. Phases 4-10
// spawned a fresh `agent/run-once.ts` for every utterance - `cmd -> npx -> tsx ->
// connect every MCP server`, each turn - which cost ~seconds of first-token
// latency and made June amnesiac between turns. Now a single `agent/serve.ts`
// stays up for the whole app session: this module spawns it once, a background
// reader thread streams its `{"t":...}` events to the windows, and each
// `run_agent` writes a `{"type":"run",...}` request and awaits that turn's
// `final`. MCP connections and conversation history stay warm; second-turn
// latency drops to the model's own first-token time.
//
// The resident is respawned (with backoff) if it crashes, and each turn has a
// watchdog so a wedged process can't hang the UI forever. Settings changes
// shut it down so the next run respawns with fresh env (the config is read once
// at spawn, unlike run-once which re-read it every turn).
//
// The approval round-trip and cross-window broadcast are unchanged from Phase 6:
// every step is an `agent://*` event tagged with `turn`, and a gated tool call
// blocks in serve.ts until `resolve_approval` writes a decision back.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

/// A turn that produces no `final` within this window is abandoned as wedged.
/// Must exceed the 120s approval timeout so a slow-to-approve turn isn't killed.
const WATCHDOG: Duration = Duration::from_secs(180);

/// Append one already-redacted, turn-stamped audit record (a `{"t":"audit",...}`
/// line from serve.ts) to `<app_data_dir>/audit.jsonl` (10.7). Best-effort: a
/// failed audit write must never break a turn, but it is the record phases 17-19
/// rely on, so failures are logged to stderr.
fn append_audit(app: &AppHandle, entry: &serde_json::Value) {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[audit] no app data dir: {e}");
            return;
        }
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("audit.jsonl");
    let line = entry.to_string();
    let write = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = write {
        eprintln!("[audit] could not write {}: {e}", path.display());
    }
}

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

/// The live resident serve.ts process. `stdin` is how requests reach it;
/// `child` is kept so a settings change / shutdown can kill it. `gen` tags this
/// incarnation so a crashed reader thread only clears the resident if it is
/// still the current one (a respawn may already have replaced it).
struct Resident {
    stdin: ChildStdin,
    child: Child,
    gen: u64,
}

/// Respawn backoff after a crash: capped exponential, so a serve.ts that keeps
/// dying (bad config, missing tsx) doesn't spin. Reset when a fresh process
/// reports `ready`.
#[derive(Default)]
struct Backoff {
    fails: u32,
    last_exit: Option<Instant>,
}

fn backoff_delay(fails: u32) -> Duration {
    let ms = 250u64.saturating_mul(1u64 << fails.min(5));
    Duration::from_millis(ms.min(8_000))
}

/// One turn's reply (or a crash/watchdog error), delivered from the reader
/// thread back to the awaiting `run_agent`.
type TurnResult = Result<String, String>;

/// The resident agent session. All state is shared `Arc`s so the async
/// commands, the blocking spawn/write path, and the stdout reader thread touch
/// the same process, approval, and event log.
#[derive(Default, Clone)]
pub struct AgentSession {
    /// The live serve.ts, or `None` before first run / after a crash.
    resident: Arc<Mutex<Option<Resident>>>,
    /// The approval currently awaiting a decision (seeds a late-opened window).
    pending: Arc<Mutex<Option<PendingApproval>>>,
    /// Recorded session events (`{name, payload}`), replayed by a window opened
    /// mid-session. Text deltas are not recorded (the `final` supersedes them).
    events: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Stamps each recorded event's `payload.seq` for replay de-duplication.
    seq: Arc<AtomicU64>,
    /// Per-turn delivery channels: the reader thread hands each `final` (or a
    /// crash error) back to the awaiting `run_agent` here.
    turns: Arc<Mutex<HashMap<u64, Sender<TurnResult>>>>,
    /// The most recently dispatched turn - a preempted (barged-in-on) turn's
    /// late approval must not surface over the newer turn's prompt.
    latest_turn: Arc<AtomicU64>,
    /// Monotonic incarnation counter for `Resident.gen`.
    generation: Arc<AtomicU64>,
    backoff: Arc<Mutex<Backoff>>,
    /// When the last turn ran. Phase 11.2: if the gap to the next turn exceeds
    /// the idle threshold, that turn starts a fresh conversation. `None` before
    /// the first turn (nothing to age out) and after an explicit new conversation.
    last_activity: Arc<Mutex<Option<Instant>>>,
    /// Recent per-turn voice-latency samples (Phase 11.5), newest last. The widget
    /// records them and the full-app Diagnostics panel reads them back - separate
    /// webviews, so this shared, capped, in-memory buffer is their common ground.
    latency: Arc<Mutex<Vec<serde_json::Value>>>,
}

/// ponytail: keep the last N latency samples for the P50/P95 readout; older ones
/// fall off. Enough to be representative without unbounded growth.
const MAX_LATENCY: usize = 100;

/// ponytail: hard cap so a tray-resident session can't grow without bound;
/// the oldest events fall off first. Bump if long sessions truncate too soon.
const MAX_EVENTS: usize = 500;

/// Turn-number space for unattended (scheduled/triggered) runs (Phase 18). Kept far
/// above the widget's small per-webview turn counter so a scheduled run can never
/// collide with an interactive turn in the shared `turns`/`pending` maps.
static UNATTENDED_TURN: AtomicU64 = AtomicU64::new(1 << 40);

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

/// Whether `elapsed` idle time crosses the reset threshold (Phase 11.2). Pure so
/// the idle rule is unit-tested without a live clock. `idle_minutes == 0` disables
/// the auto-reset; `None` elapsed (no prior turn) never resets.
fn idle_exceeded(elapsed: Option<Duration>, idle_minutes: u64) -> bool {
    idle_minutes > 0 && matches!(elapsed, Some(d) if d >= Duration::from_secs(idle_minutes * 60))
}

/// Minutes of idle after which a turn starts a fresh conversation (settings.json,
/// default 10; 0 disables). Read fresh per turn like the rest of the config.
fn idle_reset_minutes(app: &AppHandle) -> u64 {
    crate::settings::read_settings(app)
        .get("conversationIdleMinutes")
        .and_then(|v| v.as_u64())
        .unwrap_or(10)
}

/// Drop the shared conversation UI: clear the recorded session log and any
/// pending approval, then broadcast `agent://reset` so every window clears its
/// transcript. Does NOT touch the resident's own memory - callers pair this with
/// a `{"type":"reset"}` write for that (Phase 11.2).
fn clear_conversation(session: &AgentSession, app: &AppHandle) {
    session.events.lock().unwrap().clear();
    *session.pending.lock().unwrap() = None;
    let _ = app.emit("agent://reset", serde_json::json!({}));
}

/// Resolve the brain the user chose (settings.json) into environment variables
/// for the resident child (PLAN.md Phase 7). The provider's API key is read from
/// the OS keychain HERE, so it reaches the Node agent via the child's env and
/// never crosses the webview IPC boundary. A local brain (Ollama / LM Studio)
/// needs no key. The resident reads these ONCE at spawn - a settings change
/// respawns it (see `AgentSession::shutdown`).
fn brain_env(app: &AppHandle) -> Vec<(String, String)> {
    let s = crate::settings::read_settings(app);
    let brain = s.get("brain");
    let field = |k: &str| brain.and_then(|b| b.get(k)).and_then(|v| v.as_str());
    let provider = field("provider").unwrap_or("claude").to_string();

    let mut env: Vec<(String, String)> = vec![("JUNE_BRAIN_PROVIDER".into(), provider.clone())];
    if let Some(m) = field("model") {
        env.push(("JUNE_BRAIN_MODEL".into(), m.to_string()));
    }
    if let Some(b) = s.get("brainBaseUrl").and_then(|v| v.as_str()) {
        if !b.is_empty() {
            env.push(("JUNE_BRAIN_BASE_URL".into(), b.to_string()));
        }
    }
    if let Some(mode) = s.get("privacyMode").and_then(|v| v.as_str()) {
        env.push(("JUNE_PRIVACY_MODE".into(), mode.to_string()));
    }

    // Provider -> keychain service. This mapping is the execution-side counterpart
    // of the frontend registry (src/lib/providers.ts); keep them in step.
    let key_service = match provider.as_str() {
        "claude" => Some("june_provider_anthropic_api_key"),
        "openai" => Some("june_provider_openai_api_key"),
        "gemini" => Some("june_provider_google_api_key"),
        "custom" => Some("june_provider_custom_api_key"),
        _ => None, // ollama / lmstudio: local, no key
    };
    if let Some(service) = key_service {
        if let Ok(key) = crate::keychain::get_api_key_inner(service.to_string()) {
            if !key.trim().is_empty() {
                // Claude's Agent SDK reads ANTHROPIC_API_KEY; every other brain
                // reads JUNE_BRAIN_API_KEY in agent/core.ts.
                if provider == "claude" {
                    env.push(("ANTHROPIC_API_KEY".into(), key));
                } else {
                    env.push(("JUNE_BRAIN_API_KEY".into(), key));
                }
            }
        }
    }
    env
}

/// Resolve the files capability (PLAN.md Phase 9) into env for the resident.
/// Attached only when the user enabled it AND pointed it at a folder; otherwise
/// no env var, so serve.ts leaves the filesystem untouched.
fn files_env(app: &AppHandle) -> Vec<(String, String)> {
    let s = crate::settings::read_settings(app);
    let files = s.get("files");
    let enabled = files
        .and_then(|f| f.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let root = files
        .and_then(|f| f.get("root"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if enabled && !root.is_empty() {
        vec![("JUNE_FILES_ROOT".into(), root.to_string())]
    } else {
        vec![]
    }
}

/// Absolute path to June's long-term memory file (PLAN.md Phase 11.4),
/// `<app_data_dir>/june-memory.md`. One host-owned file: the model can only ever
/// append to THIS path (mcp/memory takes no path argument), so it is
/// path-contained by construction. The file need not exist yet.
fn memory_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("june-memory.md"))
}

/// Absolute path to June's post-run lessons file (improvement-4 Phase 17.1),
/// `<app_data_dir>/june-lessons.md`, next to june-memory.md. Same contract: one
/// host-owned file the model can only ever append to (mcp/lessons takes no path
/// argument), path-contained by construction. The file need not exist yet.
fn lessons_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("june-lessons.md"))
}

/// The user-added MCP capability servers (Phase 13) for the resident. Read from
/// settings.json and passed verbatim as a JSON array in JUNE_MCP_SERVERS; serve.ts
/// coerces the list, then filters it by enable + privacy mode and registers each
/// as an MCP server - so adding a capability is a settings entry, not June code.
/// A settings save shuts the resident down (settings.rs), so a new/edited server
/// takes effect on the next turn.
fn mcp_servers_env(app: &AppHandle) -> Vec<(String, String)> {
    match crate::settings::read_settings(app).get("mcpServers") {
        Some(v) if v.is_array() => vec![("JUNE_MCP_SERVERS".into(), v.to_string())],
        _ => vec![],
    }
}

/// Long-term memory path for the resident (PLAN.md Phase 11.4). Always attached:
/// memory is local and user-visible (editable/clearable in settings), so it stays
/// on in every privacy mode, like the audit log. serve.ts reads the file at spawn
/// and injects it into the system prompt; a settings save / memory edit respawns
/// the resident so the injected memory stays current.
fn memory_env(app: &AppHandle) -> Vec<(String, String)> {
    match memory_file(app) {
        Ok(p) => vec![("JUNE_MEMORY_FILE".into(), p.to_string_lossy().into_owned())],
        Err(_) => vec![],
    }
}

/// Post-run lessons path for the resident (improvement-4 Phase 17.1). Always
/// attached for the same reason as memory: lessons are local and user-visible
/// (editable/clearable in settings), so they stay on in every privacy mode.
/// serve.ts recalls the top-k relevant lessons per turn (17.2).
fn lessons_env(app: &AppHandle) -> Vec<(String, String)> {
    match lessons_file(app) {
        Ok(p) => vec![("JUNE_LESSONS_FILE".into(), p.to_string_lossy().into_owned())],
        Err(_) => vec![],
    }
}

/// Absolute path to agent/serve.ts, resolved from this crate at compile time
/// (`<repo>/src-tauri` -> `<repo>/agent/serve.ts`).
fn serve_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join("agent").join("serve.ts"))
        .unwrap_or_else(|| PathBuf::from("agent/serve.ts"))
}

/// Spawn the resident serve.ts, returning its stdin, stdout, and the child. On
/// Windows `npx` is a `.cmd` shim that can't be exec'd directly, so go through
/// the shell (the same fix openai-brain applies for its MCP clients).
fn spawn_serve(app: &AppHandle) -> Result<(ChildStdin, std::process::ChildStdout, Child), String> {
    let script = serve_script();
    let cwd = script
        .parent()
        .and_then(|agent_dir| agent_dir.parent())
        .map(|p| p.to_path_buf())
        .ok_or("Could not locate the June project root.")?;

    let mut brain_vars = brain_env(app);
    brain_vars.extend(files_env(app));
    brain_vars.extend(memory_env(app));
    brain_vars.extend(lessons_env(app));
    brain_vars.extend(mcp_servers_env(app));

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
        .envs(brain_vars)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start the agent: {e}"))?;

    let stdin = child.stdin.take().ok_or("The agent has no stdin.")?;
    let stdout = child.stdout.take().ok_or("The agent produced no output stream.")?;
    Ok((stdin, stdout, child))
}

/// Ensure a live resident exists, respawning (with backoff) if it is absent or
/// has exited. Blocking - call inside `spawn_blocking`.
fn ensure_resident(app: &AppHandle, session: &AgentSession) -> Result<(), String> {
    {
        let mut guard = session.resident.lock().unwrap();
        if let Some(r) = guard.as_mut() {
            match r.child.try_wait() {
                Ok(None) => return Ok(()), // still running
                _ => *guard = None,        // exited or unknown - respawn below
            }
        }
    }

    // Back off if a recent incarnation crashed, so a broken config can't spin.
    let delay = {
        let b = session.backoff.lock().unwrap();
        b.last_exit.map(|last| {
            let want = backoff_delay(b.fails);
            want.checked_sub(last.elapsed()).unwrap_or_default()
        })
    };
    if let Some(d) = delay {
        if !d.is_zero() {
            std::thread::sleep(d);
        }
    }

    let gen = session.generation.fetch_add(1, Ordering::Relaxed) + 1;
    let (stdin, stdout, child) = spawn_serve(app)?;
    spawn_reader(session.clone(), app.clone(), stdout, gen);
    *session.resident.lock().unwrap() = Some(Resident { stdin, child, gen });
    Ok(())
}

/// Write one JSON request line to the resident's stdin. On write failure the
/// resident is presumed dead and dropped so the next call respawns it.
fn write_request(session: &AgentSession, req: &serde_json::Value) -> Result<(), String> {
    let mut guard = session.resident.lock().unwrap();
    let resident = guard.as_mut().ok_or("The agent is not running.")?;
    let line = format!("{req}\n");
    let write = resident
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| resident.stdin.flush());
    if write.is_err() {
        *guard = None;
    }
    write.map_err(|e| format!("Could not reach the agent: {e}"))
}

/// The stdout reader thread for one resident incarnation. Streams each JSONL
/// event to the windows and delivers `final`s to the awaiting turns. On EOF the
/// child has exited: it clears the resident (if still this incarnation) and
/// fails every pending turn so no `run_agent` hangs.
fn spawn_reader(session: AgentSession, app: AppHandle, stdout: std::process::ChildStdout, gen: u64) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            let turn = v.get("turn").and_then(|x| x.as_u64()).unwrap_or(0);
            let str_at = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            match v.get("t").and_then(|t| t.as_str()) {
                Some("ready") => {
                    // A fresh process is up: clear the crash backoff.
                    let mut b = session.backoff.lock().unwrap();
                    b.fails = 0;
                    b.last_exit = None;
                }
                Some("text") => {
                    if let Some(delta) = v.get("delta").and_then(|d| d.as_str()) {
                        let _ = app.emit(
                            "agent://text",
                            serde_json::json!({ "turn": turn, "delta": delta }),
                        );
                    }
                }
                Some("tool") => record(
                    &session,
                    &app,
                    "agent://tool",
                    serde_json::json!({ "turn": turn, "action": v.get("action"), "input": v.get("input") }),
                ),
                Some("result") => record(
                    &session,
                    &app,
                    "agent://result",
                    serde_json::json!({ "turn": turn, "action": v.get("action"), "res": v.get("res"), "isError": v.get("isError") }),
                ),
                Some("approval") => {
                    // A preempted (barged-in-on) turn's approval must not surface
                    // over the newer turn: serve.ts self-denies it, so a decision
                    // could never be delivered anyway.
                    if turn == session.latest_turn.load(Ordering::Relaxed) {
                        let pa = PendingApproval {
                            turn,
                            id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
                            action: str_at("action"),
                            summary: str_at("summary"),
                            cls: str_at("cls"),
                        };
                        *session.pending.lock().unwrap() = Some(pa.clone());
                        let _ = app.emit("agent://approval", pa);
                    }
                }
                Some("approval-expired") => {
                    let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                    let mut guard = session.pending.lock().unwrap();
                    if matches!(guard.as_ref(), Some(p) if p.turn == turn && p.id == id) {
                        *guard = None;
                        drop(guard);
                        let _ = app.emit(
                            "agent://approval-resolved",
                            serde_json::json!({ "turn": turn, "id": id, "decision": "deny" }),
                        );
                    }
                }
                Some("audit") => append_audit(&app, &v),
                Some("blocked") => {
                    // Phase 18.2: an unattended run hit a gated action and blocked it
                    // (never auto-approved). Notify so the user knows a scheduled run
                    // needs their attention; the audit log holds the full record.
                    let summary = str_at("summary");
                    crate::scheduler::notify(
                        &app,
                        "June paused an unattended action",
                        if summary.is_empty() { "An action needs your approval." } else { &summary },
                    );
                }
                Some("final") => {
                    let text = str_at("text");
                    let is_error = v.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
                    record(
                        &session,
                        &app,
                        "agent://final",
                        serde_json::json!({ "turn": turn, "text": text, "isError": is_error }),
                    );
                    // Clear a dangling approval for this finished turn.
                    {
                        let mut guard = session.pending.lock().unwrap();
                        if matches!(guard.as_ref(), Some(p) if p.turn == turn) {
                            *guard = None;
                        }
                    }
                    if let Some(tx) = session.turns.lock().unwrap().remove(&turn) {
                        // June speaks the text even on an error final, matching the
                        // pre-11 behaviour; the recorded event carries isError for UI.
                        let _ = tx.send(Ok(text));
                    }
                }
                _ => {}
            }
        }

        // EOF: the child exited. If we are still the current incarnation, drop it,
        // record the crash for backoff, and fail every in-flight turn so no
        // command hangs waiting for a `final` that will never come.
        let mut guard = session.resident.lock().unwrap();
        if matches!(guard.as_ref(), Some(r) if r.gen == gen) {
            *guard = None;
            drop(guard);
            {
                let mut b = session.backoff.lock().unwrap();
                b.fails = b.fails.saturating_add(1);
                b.last_exit = Some(Instant::now());
            }
            *session.pending.lock().unwrap() = None;
            let mut turns = session.turns.lock().unwrap();
            for (_, tx) in turns.drain() {
                let _ = tx.send(Err("The agent stopped unexpectedly.".to_string()));
            }
        }
    });
}

impl AgentSession {
    /// Kill the resident so the next `run_agent` respawns it - called when
    /// settings change (the child reads its config once at spawn).
    pub fn shutdown(&self) {
        if let Some(mut r) = self.resident.lock().unwrap().take() {
            let _ = r.child.kill();
        }
    }
}

/// Run one agent turn from the given transcript and return June's spoken-style
/// reply. Streams every step as an `agent://*` event tagged with `turn`. Errors
/// come back as `Err` so the UI can surface them instead of pretending success.
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

    let session = session.inner().clone();
    session.latest_turn.store(turn, Ordering::Relaxed);

    // Phase 11.2: if too long has passed since the last turn, this turn starts a
    // fresh conversation - clear the UI now (before the new user message) and tell
    // the resident to drop its memory below (before the run request). Then stamp
    // the activity clock so the NEXT turn's idle gap is measured from here.
    let reset_first = idle_exceeded(
        session.last_activity.lock().unwrap().map(|t| t.elapsed()),
        idle_reset_minutes(&app),
    );
    if reset_first {
        clear_conversation(&session, &app);
    }
    *session.last_activity.lock().unwrap() = Some(Instant::now());

    // Register this turn's delivery channel BEFORE the run request, so the reader
    // can never deliver a `final` before we are listening.
    let (tx, rx): (Sender<TurnResult>, Receiver<TurnResult>) = std::sync::mpsc::channel();
    session.turns.lock().unwrap().insert(turn, tx);

    // Mirror the user's message to any open window before June starts working.
    record(
        &session,
        &app,
        "agent://user",
        serde_json::json!({ "turn": turn, "text": transcript }),
    );

    // Ensure the resident is up and hand it the run request - both blocking.
    let ensure = {
        let app = app.clone();
        let session = session.clone();
        let transcript = transcript.clone();
        tauri::async_runtime::spawn_blocking(move || {
            ensure_resident(&app, &session)?;
            // Drop the resident's conversation before the run so this turn starts
            // fresh. Best-effort: a freshly (re)spawned resident is already empty,
            // so a failed/no-op reset is harmless; the run below is what matters.
            if reset_first {
                let _ = write_request(
                    &session,
                    &serde_json::json!({ "type": "reset" }),
                );
            }
            write_request(
                &session,
                &serde_json::json!({ "type": "run", "turn": turn, "transcript": transcript }),
            )
        })
        .await
        .map_err(|e| format!("Agent task failed: {e}"))?
    };
    if let Err(e) = ensure {
        session.turns.lock().unwrap().remove(&turn);
        return Err(e);
    }

    // Await this turn's `final` (or a crash error) with a watchdog: a wedged
    // resident must not hang the UI. On timeout, shut it down so the next run
    // gets a fresh process.
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(WATCHDOG))
        .await
        .map_err(|e| format!("Agent task failed: {e}"))?;

    match outcome {
        Ok(result) => result,
        Err(_) => {
            session.turns.lock().unwrap().remove(&turn);
            session.shutdown();
            let msg = "The agent did not respond in time.".to_string();
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

impl AgentSession {
    /// True if a turn is in flight or an approval is pending. The scheduler (Phase
    /// 18) checks this before firing so an unattended run never preempts (barges in
    /// on) an interactive turn the user is in the middle of - it just waits for the
    /// next tick. Also serializes unattended runs against each other.
    pub fn is_busy(&self) -> bool {
        !self.turns.lock().unwrap().is_empty() || self.pending.lock().unwrap().is_some()
    }
}

/// Run one UNATTENDED turn to completion and return June's reply text (Phase 18).
/// Blocking - called from the scheduler thread, which serializes these so they
/// never preempt each other. Reuses the resident and the per-turn delivery channel;
/// the run request carries `unattended:true` so serve.ts blocks every gated action
/// (18.2). `source` labels the origin ("schedule: X" / "trigger: Y"); `untrusted`
/// is a trigger's watched-file contents, fenced off in the prompt as data (18.3).
/// The user message and final reply land in the shared session log ("results land
/// in the session log", 18.1). ponytail: the unattended turn shares the resident's
/// one conversation; a scheduled run fires when idle, so pollution is rare - an
/// isolated second resident is the upgrade if it ever bites.
pub fn run_unattended(
    app: &AppHandle,
    session: &AgentSession,
    prompt: String,
    source: String,
    untrusted: Option<String>,
) -> Result<String, String> {
    let turn = UNATTENDED_TURN.fetch_add(1, Ordering::Relaxed);

    let (tx, rx): (Sender<TurnResult>, Receiver<TurnResult>) = std::sync::mpsc::channel();
    session.turns.lock().unwrap().insert(turn, tx);

    // Show the run's origin (not the whole prompt) in the shared session log.
    record(session, app, "agent://user", serde_json::json!({ "turn": turn, "text": format!("[{source}]") }));

    let mut req = serde_json::json!({
        "type": "run", "turn": turn, "transcript": prompt, "unattended": true, "source": source,
    });
    if let Some(u) = untrusted {
        req["untrusted"] = serde_json::Value::String(u);
    }

    let dispatch = ensure_resident(app, session).and_then(|_| write_request(session, &req));
    if let Err(e) = dispatch {
        session.turns.lock().unwrap().remove(&turn);
        return Err(e);
    }

    match rx.recv_timeout(WATCHDOG) {
        Ok(result) => result,
        Err(_) => {
            session.turns.lock().unwrap().remove(&turn);
            session.shutdown();
            let msg = "The unattended run did not respond in time.".to_string();
            record(
                session,
                app,
                "agent://final",
                serde_json::json!({ "turn": turn, "text": msg, "isError": true }),
            );
            Err(msg)
        }
    }
}

/// Answer the pending approval by writing a decision to the resident's stdin,
/// then broadcast the resolution so every window clears its prompt. `decision`
/// is "allow" or "deny" (anything else is treated as deny).
#[tauri::command]
pub fn resolve_approval(
    app: AppHandle,
    session: State<'_, AgentSession>,
    id: u64,
    decision: String,
) -> Result<(), String> {
    let decision = if decision == "allow" { "allow" } else { "deny" };
    // Validate against the pending approval before touching stdin: a decision for
    // an approval that is no longer pending (expired, decided in the other window)
    // must not reach the resident.
    let turn = match session.pending.lock().unwrap().as_ref() {
        Some(p) if p.id == id => p.turn,
        _ => return Err("That approval is no longer pending.".to_string()),
    };

    write_request(
        session.inner(),
        &serde_json::json!({ "type": "approve", "approvalId": id, "decision": decision }),
    )?;

    *session.pending.lock().unwrap() = None;
    let _ = app.emit(
        "agent://approval-resolved",
        serde_json::json!({ "turn": turn, "id": id, "decision": decision }),
    );
    Ok(())
}

/// Abort an in-flight turn (Phase 11.3 barge-in / Cancel): tell the resident to
/// interrupt the brain mid-generation so a barged-in-on or cancelled turn stops
/// spending tokens at once instead of running to completion unheard. serve.ts
/// interrupts only if `turn` is still the active turn and self-denies its pending
/// gate, so cancelling an already-finished turn (or with no resident) is a
/// harmless no-op - hence best-effort.
#[tauri::command]
pub fn cancel_agent(session: State<'_, AgentSession>, turn: u64) -> Result<(), String> {
    let _ = write_request(
        session.inner(),
        &serde_json::json!({ "type": "cancel", "turn": turn }),
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
/// this before applying live events (deduplicated by each payload's `seq`).
#[tauri::command]
pub fn session_events(session: State<'_, AgentSession>) -> Vec<serde_json::Value> {
    session.events.lock().unwrap().clone()
}

/// Append a finished turn's latency sample to the shared, capped buffer (Phase
/// 11.5). Called by the widget after each spoken reply; the payload is the
/// `{stt, brain, tts, total}` breakdown the webview computed. Best-effort - a
/// diagnostics record must never disturb the voice pipeline.
#[tauri::command]
pub fn record_latency(session: State<'_, AgentSession>, sample: serde_json::Value) {
    push_capped(&mut session.latency.lock().unwrap(), sample, MAX_LATENCY);
}

/// Push `item`, then trim the oldest so `buf` never exceeds `cap`. Pure so the
/// ring behaviour is unit-tested without a live session.
fn push_capped(buf: &mut Vec<serde_json::Value>, item: serde_json::Value, cap: usize) {
    buf.push(item);
    if buf.len() > cap {
        let excess = buf.len() - cap;
        buf.drain(..excess);
    }
}

/// The recent latency samples, oldest first, for the Diagnostics panel (Phase
/// 11.5). The panel computes P50/P95 from these.
#[tauri::command]
pub fn latency_samples(session: State<'_, AgentSession>) -> Vec<serde_json::Value> {
    session.latency.lock().unwrap().clone()
}

/// Start a fresh conversation on demand (Phase 11.2 "new conversation", from
/// either face). Tells the resident to drop its memory, clears the shared UI
/// transcript, and resets the idle clock so both windows show an empty session.
#[tauri::command]
pub fn new_conversation(app: AppHandle, session: State<'_, AgentSession>) -> Result<(), String> {
    let session = session.inner().clone();
    // Best-effort: with no resident yet there is nothing to drop, but the UI is
    // still cleared so the button always gives immediate, honest feedback.
    let _ = write_request(&session, &serde_json::json!({ "type": "reset" }));
    clear_conversation(&session, &app);
    *session.last_activity.lock().unwrap() = None;
    Ok(())
}

/// Read "what June remembers" for the settings surface (PLAN.md Phase 11.4). A
/// missing file reads as empty, so a fresh install shows a blank, editable memory.
#[tauri::command]
pub fn read_memory(app: AppHandle) -> Result<String, String> {
    let path = memory_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Save the user-edited memory (PLAN.md Phase 11.4 "what June remembers"; clearing
/// is just an empty save). Written atomically (temp + rename), then the resident is
/// shut down so the next turn respawns and re-injects the edited memory into the
/// system prompt - the same mechanism a settings change uses.
#[tauri::command]
pub fn write_memory(
    app: AppHandle,
    session: State<'_, AgentSession>,
    content: String,
) -> Result<(), String> {
    let path = memory_file(&app)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    session.shutdown();
    Ok(())
}

/// Read "what June has learned" for the settings surface (Phase 17.1). A missing
/// file reads as empty, so a fresh install shows a blank, editable lessons list.
#[tauri::command]
pub fn read_lessons(app: AppHandle) -> Result<String, String> {
    let path = lessons_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Save the user-edited lessons (Phase 17.1 "what June has learned"; clearing is
/// an empty save). Written atomically (temp + rename), then the resident is shut
/// down so the next turn respawns and picks up the edited lessons - the same
/// mechanism memory and settings changes use.
#[tauri::command]
pub fn write_lessons(
    app: AppHandle,
    session: State<'_, AgentSession>,
    content: String,
) -> Result<(), String> {
    let path = lessons_file(&app)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    session.shutdown();
    Ok(())
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

    #[test]
    fn idle_exceeded_respects_threshold_and_disable() {
        // No prior turn -> never reset, whatever the threshold.
        assert!(!idle_exceeded(None, 10));
        // Disabled (0 minutes) -> never reset, even after a long gap.
        assert!(!idle_exceeded(Some(Duration::from_secs(3600)), 0));
        // Under the threshold stays; at/over it resets.
        assert!(!idle_exceeded(Some(Duration::from_secs(9 * 60)), 10));
        assert!(idle_exceeded(Some(Duration::from_secs(10 * 60)), 10));
        assert!(idle_exceeded(Some(Duration::from_secs(11 * 60)), 10));
    }

    #[test]
    fn push_capped_keeps_the_newest_window() {
        let mut buf = Vec::new();
        for i in 0..(MAX_LATENCY + 5) {
            push_capped(&mut buf, serde_json::json!({ "total": i }), MAX_LATENCY);
        }
        assert_eq!(buf.len(), MAX_LATENCY);
        // Oldest five dropped; the buffer keeps the newest window.
        assert_eq!(buf[0]["total"].as_u64(), Some(5));
        assert_eq!(buf[MAX_LATENCY - 1]["total"].as_u64(), Some(MAX_LATENCY as u64 + 4));
    }

    #[test]
    fn backoff_delay_is_capped_and_grows() {
        assert_eq!(backoff_delay(0), Duration::from_millis(250));
        assert_eq!(backoff_delay(1), Duration::from_millis(500));
        // Capped at 8s no matter how many failures.
        assert_eq!(backoff_delay(20), Duration::from_millis(8_000));
    }
}
