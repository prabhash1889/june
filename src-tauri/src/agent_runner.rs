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
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Local;
use tauri::{AppHandle, Emitter, Manager, State};

/// Idle watchdog (B3.2): a turn that emits NO reader event (text/tool/result/
/// approval/final) for this long is abandoned as wedged. This is a SILENCE window,
/// not a wall-clock cap - any activity resets it - so a genuinely long turn (real
/// work, or a 120s approval) survives while a truly hung process still times out.
const WATCHDOG: Duration = Duration::from_secs(180);

/// Roll `audit.jsonl` to `audit.jsonl.1` once it passes this size (B4.5), so the
/// tray resident's audit trail can't grow without bound.
const MAX_AUDIT_BYTES: u64 = 5 * 1024 * 1024;

/// Append one already-redacted, turn-stamped audit record (a `{"t":"audit",...}`
/// line from serve.ts) to `<app_data_dir>/audit.jsonl` (10.7). Best-effort: a
/// failed audit write must never break a turn, but it is the record phases 17-19
/// rely on, so failures are logged to stderr.
fn append_audit(app: &AppHandle, entry: &serde_json::Value) {
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

/// Roll `june-runs.jsonl` at this size, mirroring the audit log's rotation (P1.3).
const MAX_RUNS_BYTES: u64 = 2 * 1024 * 1024;

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

/// Drain the blocked-actions collected for an unattended `turn` (P1.3), so each
/// run's ledger record carries exactly what it wanted to do but couldn't.
fn drain_blocked(session: &AgentSession, turn: u64) -> Vec<String> {
    session.blocked_actions.lock().unwrap().remove(&turn).unwrap_or_default()
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

/// One turn's reply: the spoken text plus the brain's error flag. `is_error` rides
/// ALONGSIDE the text (not as an `Err`) so the voice path still speaks an error
/// reply, while a mission run can count a brain-flagged task as failed (B3.4).
#[derive(Clone, serde::Serialize)]
pub struct TurnReply {
    pub(crate) text: String,
    #[serde(rename = "isError")]
    pub(crate) is_error: bool,
    /// This turn's token/cost usage from the `final` event (2.6), when the brain
    /// reported it. Carried so the caller can write it into the run ledger.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) usage: Option<serde_json::Value>,
}

/// Cumulative token/cost totals across the whole app session (2.6), read back by
/// the Diagnostics panel next to the latency percentiles. Both brains report
/// tokens; only Claude reports a dollar cost, so `cost_usd` may stay 0.
#[derive(Default, Clone, serde::Serialize)]
pub struct UsageTotals {
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
    #[serde(rename = "costUsd")]
    cost_usd: f64,
    turns: u64,
}

/// One turn's outcome delivered to the awaiting caller: the reply, or a
/// crash/watchdog error message.
type TurnOutcome = Result<TurnReply, String>;

/// Reader-thread -> awaiting-caller messages for one turn. `Activity` is any
/// streamed event (text/tool/result/approval) and resets the idle watchdog so a
/// long-but-live turn isn't killed (B3.2); `Done` carries the final outcome.
enum TurnMsg {
    Activity,
    Done(TurnOutcome),
}

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
    /// crash error) back to the awaiting `run_agent` here, plus `Activity` pings
    /// that reset the idle watchdog (B3.2).
    turns: Arc<Mutex<HashMap<u64, Sender<TurnMsg>>>>,
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
    /// Cumulative token/cost usage across this app session (2.6), summed from each
    /// turn's `final` event and read back by Diagnostics. In-memory like `latency`;
    /// resets when the app restarts.
    usage: Arc<Mutex<UsageTotals>>,
    /// Voice-stack health (2.7): subsystem id (`barge`/`endpointing`/`wake`) ->
    /// `{path, error?}`, written by the widget when each VAD/wake path initializes
    /// and read back by Diagnostics. Surfaces a silent Silero/openWakeWord
    /// asset-load failure that would otherwise downgrade voice with no signal.
    voice_health: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    /// A config change (settings/memory/lessons edit) arrived while a turn was in
    /// flight (B2.1). The resident reads its env once at spawn, so it must respawn -
    /// but killing it now would abort the running turn (the exact "The agent stopped
    /// unexpectedly" the review found). Instead we mark it here and respawn lazily:
    /// when the turn finishes (reader `final`) or at the next turn's spawn.
    respawn_pending: Arc<AtomicBool>,
    /// Gated actions blocked (auto-denied) per unattended turn (improvement-5 P1.3),
    /// collected by the reader thread so `run_unattended` can record what a headless
    /// run couldn't do in the run ledger. Drained per turn once the run finishes.
    blocked_actions: Arc<Mutex<HashMap<u64, Vec<String>>>>,
    /// Mission toolset filter (improvement-5 P2 5.4): while a mission that named a
    /// toolset runs, only these generic-server ids ride into JUNE_MCP_SERVERS at
    /// spawn, so the session's tool surface stays lean. `None` = no restriction.
    /// Set/cleared by the mission runner, paired with `request_respawn`.
    mcp_filter: Arc<Mutex<Option<Vec<String>>>>,
    /// True while `ensure_resident` is (backing off and) spawning the child (1.11).
    /// `write_request` checks this FIRST and fails fast instead of blocking on the
    /// resident mutex, which `ensure_resident` holds across the up-to-8s backoff
    /// sleep + spawn - otherwise an approval click during a respawn freezes the UI.
    spawning: Arc<AtomicBool>,
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

/// Apply a deferred (B2.1) respawn once the session is idle: a settings/memory/
/// lessons change that landed mid-turn marked the resident for respawn instead of
/// killing it. Now that no turn is in flight, drop the child so the next turn
/// spawns with the fresh env. A no-op while still busy - the flag stays set until
/// the last turn drains.
fn apply_pending_respawn(session: &AgentSession) {
    if session.respawn_pending.load(Ordering::Relaxed) && !session.is_busy() {
        session.respawn_pending.store(false, Ordering::Relaxed);
        session.shutdown();
    }
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
/// settings.json and passed as a JSON array in JUNE_MCP_SERVERS; serve.ts
/// coerces the list, then filters it by enable + privacy mode and registers each
/// as an MCP server - so adding a capability is a settings entry, not June code.
/// A settings save shuts the resident down (settings.rs), so a new/edited server
/// takes effect on the next turn. While a mission with a named toolset runs
/// (improvement-5 P2 5.4), the session's filter keeps only those servers.
fn mcp_servers_env(app: &AppHandle, session: &AgentSession) -> Vec<(String, String)> {
    let Some(serde_json::Value::Array(entries)) =
        crate::settings::read_settings(app).get("mcpServers").cloned()
    else {
        return vec![];
    };
    let filtered: Vec<serde_json::Value> = match session.mcp_filter.lock().unwrap().as_ref() {
        Some(ids) => entries
            .into_iter()
            .filter(|e| {
                e.get("id")
                    .and_then(|x| x.as_str())
                    .is_some_and(|id| ids.iter().any(|w| w == id))
            })
            .collect(),
        None => entries,
    };
    vec![(
        "JUNE_MCP_SERVERS".into(),
        serde_json::Value::Array(filtered).to_string(),
    )]
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

/// settings.json path for the resident's automation capability (improvement-5
/// P1.5). Always attached: the automation server writes schedules/watch loops the
/// scheduler reads each tick. Local + user-visible, so on in every privacy mode.
fn settings_env(app: &AppHandle) -> Vec<(String, String)> {
    match crate::settings::settings_file(app) {
        Some(p) => vec![("JUNE_SETTINGS_FILE".into(), p.to_string_lossy().into_owned())],
        None => vec![],
    }
}

/// How the resident agent is launched (improvement-7 1.1). Debug builds run the
/// repo's agent/serve.ts via npx tsx (the dev loop). Release builds run the
/// esbuild bundle from the app's resources under the pinned sidecar node.exe
/// installed next to the main executable - no repo checkout, no npx/tsx, no
/// CARGO_MANIFEST_DIR runtime dependence. JUNE_BUNDLE_DIR tells serve.mjs (via
/// agent/core.ts + claude-brain.ts) to resolve the bundled MCP servers and the
/// native Claude binary from that same directory.
#[cfg(debug_assertions)]
fn serve_command(_app: &AppHandle) -> Result<Command, String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join("agent").join("serve.ts"))
        .ok_or("Could not locate the June project root.")?;
    let cwd = script
        .parent()
        .and_then(|agent_dir| agent_dir.parent())
        .map(|p| p.to_path_buf())
        .ok_or("Could not locate the June project root.")?;
    // On Windows `npx` is a `.cmd` shim that can't be exec'd directly, so go
    // through the shell (the same fix openai-brain applies for its MCP clients).
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npx");
        c
    } else {
        Command::new("npx")
    };
    cmd.arg("tsx").arg(&script).current_dir(&cwd);
    Ok(cmd)
}

#[cfg(not(debug_assertions))]
fn serve_command(app: &AppHandle) -> Result<Command, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not locate the app resources: {e}"))?
        .join("resources")
        .join("agent");
    let node = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .ok_or("Could not locate the sidecar Node runtime.")?;
    let mut cmd = Command::new(node);
    cmd.arg(resources.join("serve.mjs"))
        .current_dir(&resources)
        .env("JUNE_BUNDLE_DIR", &resources);
    Ok(cmd)
}

/// Spawn the resident agent, returning its stdin, stdout, and the child.
fn spawn_serve(
    app: &AppHandle,
    session: &AgentSession,
) -> Result<(ChildStdin, std::process::ChildStdout, Child), String> {
    let mut brain_vars = brain_env(app);
    brain_vars.extend(files_env(app));
    brain_vars.extend(memory_env(app));
    brain_vars.extend(lessons_env(app));
    brain_vars.extend(settings_env(app));
    brain_vars.extend(mcp_servers_env(app, session));

    let mut cmd = serve_command(app)?;
    // 1.3: JUNE_APPROVE=allow is a test-only headless policy that auto-approves
    // every gated action (agent/serve.ts). Strip it from the resident's inherited
    // env in release builds so a stray var on a user machine can never silently
    // disable the approval gate. Dev/test builds keep it for the text harness.
    #[cfg(not(debug_assertions))]
    cmd.env_remove("JUNE_APPROVE");
    let mut child = cmd
        .envs(brain_vars)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Pipe (not inherit) the resident's stderr so serve.ts crash output and its
        // console.error's survive on a windowed release build (2.1): a reader thread
        // routes each line into june.log. Draining it also avoids a full-pipe stall.
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the agent: {e}"))?;

    let stdin = child.stdin.take().ok_or("The agent has no stdin.")?;
    let stdout = child.stdout.take().ok_or("The agent produced no output stream.")?;
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                crate::logf::log(&app, &format!("[serve] {line}"));
            }
        });
    }
    Ok((stdin, stdout, child))
}

/// Ensure a live resident exists, respawning (with backoff) if it is absent or
/// has exited. Blocking - call inside `spawn_blocking`.
fn ensure_resident(app: &AppHandle, session: &AgentSession) -> Result<(), String> {
    // B2.1: a config change deferred while a turn was running is applied at this
    // spawn boundary - drop the stale-env child so the block below respawns it.
    if session.respawn_pending.swap(false, Ordering::Relaxed) {
        session.shutdown();
    }
    // Hold the resident lock across the check AND the spawn (B4.3): otherwise two
    // callers (an interactive turn and a scheduled/mission run, say) can both see
    // "no resident" and each spawn one, orphaning a child (and its reader thread).
    // Blocking while holding it is fine - ensure_resident always runs inside
    // spawn_blocking or the scheduler thread, and a concurrent write_request simply
    // waits for the spawn to finish, which is exactly what we want.
    let mut guard = session.resident.lock().unwrap();
    if let Some(r) = guard.as_mut() {
        match r.child.try_wait() {
            Ok(None) => return Ok(()), // still running
            _ => *guard = None,        // exited or unknown - respawn below
        }
    }

    // Signal write_request to fail fast rather than block on the resident mutex for
    // the whole backoff + spawn below (1.11): we hold `guard` across it (B4.3, to
    // prevent a double-spawn), so without this flag an approval click mid-respawn
    // would wait up to 8s for the lock and freeze the UI.
    session.spawning.store(true, Ordering::Relaxed);

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
    let spawned = spawn_serve(app, session);
    let (stdin, stdout, child) = match spawned {
        Ok(v) => v,
        Err(e) => {
            session.spawning.store(false, Ordering::Relaxed);
            return Err(e);
        }
    };
    spawn_reader(session.clone(), app.clone(), stdout, gen);
    *guard = Some(Resident { stdin, child, gen });
    session.spawning.store(false, Ordering::Relaxed);
    Ok(())
}

/// Write one JSON request line to the resident's stdin. On write failure the
/// resident is presumed dead and dropped so the next call respawns it.
fn write_request(session: &AgentSession, req: &serde_json::Value) -> Result<(), String> {
    // Fail fast during a respawn (1.11): ensure_resident holds the resident mutex
    // across its backoff + spawn, so blocking here would freeze an approval click
    // for up to 8s. The caller (an approval decision) can just retry once up.
    if session.spawning.load(Ordering::Relaxed) {
        return Err("The agent is starting up; try again in a moment.".to_string());
    }
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
                    bump_activity(&session, turn);
                }
                Some("tool") => {
                    record(
                        &session,
                        &app,
                        "agent://tool",
                        serde_json::json!({ "turn": turn, "action": v.get("action"), "input": v.get("input") }),
                    );
                    bump_activity(&session, turn);
                }
                Some("result") => {
                    record(
                        &session,
                        &app,
                        "agent://result",
                        serde_json::json!({ "turn": turn, "action": v.get("action"), "res": v.get("res"), "isError": v.get("isError") }),
                    );
                    bump_activity(&session, turn);
                }
                Some("approval") => {
                    // An approval is progress: reset the idle watchdog while the user
                    // decides (B3.2) even for a preempted turn (harmless - it will get
                    // a `final` eventually and be removed).
                    bump_activity(&session, turn);
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
                            serde_json::json!({ "turn": turn, "id": id, "decision": "deny", "reason": "expired" }),
                        );
                    }
                }
                Some("error") => {
                    // serve.ts failed to START (main() threw before `ready`): it emits
                    // this then exits (2.5). Without this arm the only signal was the
                    // EOF path's generic "stopped unexpectedly" - deliver the REAL
                    // reason to any awaiting turn and record it. The child still exits
                    // next, so the EOF handler runs backoff afterward.
                    let text = str_at("text");
                    let text = if text.is_empty() { "June's agent failed to start.".to_string() } else { text };
                    crate::logf::log(&app, &format!("[serve] {text}"));
                    let mut turns = session.turns.lock().unwrap();
                    for (_, tx) in turns.drain() {
                        let _ = tx.send(TurnMsg::Done(Err(text.clone())));
                    }
                }
                Some("audit") => append_audit(&app, &v),
                Some("blocked") => {
                    // Phase 18.2: an unattended run hit a gated action and blocked it
                    // (never auto-approved). Notify so the user knows a scheduled run
                    // needs their attention; the audit log holds the full record.
                    let summary = str_at("summary");
                    let action = str_at("action");
                    // Record it against this turn for the run ledger (P1.3), so the
                    // Runs tab shows what a headless run wanted to do but couldn't.
                    let label = if summary.is_empty() { action } else { summary.clone() };
                    session.blocked_actions.lock().unwrap().entry(turn).or_default().push(label);
                    crate::scheduler::notify(
                        &app,
                        "June paused an unattended action",
                        if summary.is_empty() { "An action needs your approval." } else { &summary },
                    );
                }
                Some("final") => {
                    let text = str_at("text");
                    let is_error = v.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
                    // Accumulate this turn's token/cost into the session total (2.6)
                    // and hold the per-turn block to ride into the run ledger.
                    let usage = v.get("usage").filter(|u| u.is_object()).cloned();
                    if let Some(u) = &usage {
                        let mut totals = session.usage.lock().unwrap();
                        totals.input_tokens += u.get("inputTokens").and_then(|x| x.as_u64()).unwrap_or(0);
                        totals.output_tokens += u.get("outputTokens").and_then(|x| x.as_u64()).unwrap_or(0);
                        totals.cost_usd += u.get("costUsd").and_then(|x| x.as_f64()).unwrap_or(0.0);
                        totals.turns += 1;
                    }
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
                        // The reply carries `is_error` alongside the text (B3.4): the
                        // voice path still speaks it (pre-11 behaviour), but a mission
                        // run can now count a brain-flagged task as failed.
                        let _ = tx.send(TurnMsg::Done(Ok(TurnReply { text, is_error, usage })));
                    }
                    // B2.1: a config change deferred mid-turn can land now the turn is done.
                    apply_pending_respawn(&session);
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
                let _ = tx.send(TurnMsg::Done(Err("The agent stopped unexpectedly.".to_string())));
            }
        }
    });
}

/// Tear down the resident serve.ts and its ENTIRE process tree (1.10). On Windows
/// the child is a `cmd /C npx tsx serve.ts` wrapper, so `Child::kill()` reaps only
/// the `cmd.exe` shell and orphans the live npx/node/tsx descendants - each still
/// holding open MCP stdio clients - which leaked on every respawn and every Quit.
///
/// Graceful first: dropping stdin closes it, and serve.ts exits on stdin EOF
/// (disposing its MCP connections cleanly). If it hasn't exited within the deadline
/// (wedged), force-kill the whole tree with `taskkill /T /F`, then reap the child.
fn kill_tree(stdin: ChildStdin, mut child: Child) {
    drop(stdin); // EOF -> serve.ts's reader "close" -> dispose + exit
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return, // exited on its own - clean shutdown, tree gone
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => break, // still alive past the deadline, or errored - force-kill below
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait(); // reap so it doesn't linger as a zombie
}

impl AgentSession {
    /// Kill the resident so the next `run_agent` respawns it. Unconditional - used
    /// by the watchdog to drop a wedged process. A config change should go through
    /// `request_respawn` instead, which defers this when a turn is in flight.
    pub fn shutdown(&self) {
        // Take the resident OUT of the lock before the (up-to-1.5s) teardown, so
        // kill_tree never blocks a concurrent write_request on the resident mutex.
        let taken = self.resident.lock().unwrap().take();
        if let Some(r) = taken {
            kill_tree(r.stdin, r.child);
        }
    }

    /// Apply a config change (settings / memory / lessons edit) to the resident,
    /// which reads its env once at spawn. If a turn is in flight, killing the child
    /// now would abort it - a settings save or a review-gate correction must never
    /// kill the very command being sent (B2.1/B2.2) - so mark a respawn instead; it
    /// lands when the turn finishes (reader `final`) or at the next spawn
    /// (`ensure_resident`). Idle -> shut down at once, as before.
    pub fn request_respawn(&self) {
        if self.is_busy() {
            self.respawn_pending.store(true, Ordering::Relaxed);
        } else {
            self.shutdown();
        }
    }

    /// Set/clear the mission toolset filter (improvement-5 P2 5.4). Takes effect at
    /// the next resident spawn - callers pair this with `request_respawn`.
    pub fn set_mcp_filter(&self, ids: Option<Vec<String>>) {
        *self.mcp_filter.lock().unwrap() = ids;
    }
}

/// Ping the awaiting caller that turn `turn` produced a reader event, resetting its
/// idle watchdog (B3.2). Best-effort: a finished/unknown turn (or turn 0, which is
/// the not-a-turn `ready` event) just no-ops.
fn bump_activity(session: &AgentSession, turn: u64) {
    if turn == 0 {
        return;
    }
    if let Some(tx) = session.turns.lock().unwrap().get(&turn) {
        let _ = tx.send(TurnMsg::Activity);
    }
}

/// Block until this turn's `Done` arrives, resetting the `idle` silence window on
/// every `Activity` (B3.2). `Err(())` means the watchdog fired - `idle` elapsed with
/// no event, or the sender was dropped - so the caller tears the wedged resident
/// down. Split out and parameterized on `idle` so the reset rule is unit-tested
/// without a live turn.
fn await_turn(rx: &Receiver<TurnMsg>, idle: Duration) -> Result<TurnOutcome, ()> {
    loop {
        match rx.recv_timeout(idle) {
            Ok(TurnMsg::Activity) => continue,
            Ok(TurnMsg::Done(outcome)) => return Ok(outcome),
            Err(_) => return Err(()),
        }
    }
}

/// Handle a watchdog-wedged turn uniformly (7.8b): drop the turn slot, shut the
/// resident down so the next run gets a fresh process, and record `msg` as this
/// turn's errored `final` in the session log. The three turn pipelines (run_agent /
/// run_attended / run_unattended) share this tail - each supplies its own message and
/// maps the result its own way (the unattended path also writes a ledger record on
/// top). The pipelines otherwise legitimately differ (async spawn_blocking + idle
/// reset, a busy-recheck, the ledger, distinct return types), so only this common
/// wedge policy is factored out rather than forced into one flag-driven core.
fn fail_wedged_turn(app: &AppHandle, session: &AgentSession, turn: u64, msg: &str) {
    session.turns.lock().unwrap().remove(&turn);
    session.shutdown();
    record(
        session,
        app,
        "agent://final",
        serde_json::json!({ "turn": turn, "text": msg, "isError": true }),
    );
}

/// Run one agent turn from the given transcript and return June's spoken-style
/// reply (with the brain's `isError` flag, B3.4). Streams every step as an
/// `agent://*` event tagged with `turn`. A crash/watchdog comes back as `Err` so
/// the UI can surface it instead of pretending success.
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    session: State<'_, AgentSession>,
    transcript: String,
    turn: u64,
) -> Result<TurnReply, String> {
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
    let (tx, rx): (Sender<TurnMsg>, Receiver<TurnMsg>) = std::sync::mpsc::channel();
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
    let outcome = tauri::async_runtime::spawn_blocking(move || await_turn(&rx, WATCHDOG))
        .await
        .map_err(|e| format!("Agent task failed: {e}"))?;

    match outcome {
        Ok(result) => result,
        Err(()) => {
            let msg = "The agent did not respond in time.".to_string();
            fail_wedged_turn(&app, &session, turn, &msg);
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

/// Run one ATTENDED turn from a Rust-side driver (the mission runner, improvement-5
/// P2 5.2). Blocking - call from a dedicated thread, never the main thread. Unlike
/// `run_unattended`, the normal approval gate applies: a gated call raises the
/// shared approval card in both faces (a mission is not a bypass - and not a leash
/// either). The caller owns busy-scheduling; a user turn that arrives mid-run
/// preempts this one via serve.ts's barge-in, which lands here as an errored reply.
pub(crate) fn run_attended(
    app: &AppHandle,
    session: &AgentSession,
    prompt: String,
    turn: u64,
) -> Result<TurnReply, String> {
    let transcript = prompt.trim().to_string();
    if transcript.is_empty() {
        return Err("Nothing to send: the transcript was empty.".to_string());
    }
    ensure_resident(app, session)?;
    // Approvals raised by this turn must surface: the reader drops approvals from
    // any turn that isn't the latest.
    session.latest_turn.store(turn, Ordering::Relaxed);
    *session.last_activity.lock().unwrap() = Some(Instant::now());

    let (tx, rx): (Sender<TurnMsg>, Receiver<TurnMsg>) = std::sync::mpsc::channel();
    session.turns.lock().unwrap().insert(turn, tx);
    record(
        session,
        app,
        "agent://user",
        serde_json::json!({ "turn": turn, "text": transcript }),
    );
    if let Err(e) = write_request(
        session,
        &serde_json::json!({ "type": "run", "turn": turn, "transcript": transcript }),
    ) {
        session.turns.lock().unwrap().remove(&turn);
        return Err(e);
    }
    match await_turn(&rx, WATCHDOG) {
        Ok(outcome) => outcome,
        Err(()) => {
            let msg = "The agent did not respond in time.".to_string();
            fail_wedged_turn(app, session, turn, &msg);
            Err(msg)
        }
    }
}

/// Abort turn `turn` from Rust (the mission runner's Stop). Best-effort, like the
/// `cancel_agent` command it shares its body with.
pub(crate) fn cancel_turn(session: &AgentSession, turn: u64) {
    let _ = write_request(
        session,
        &serde_json::json!({ "type": "cancel", "turn": turn }),
    );
}

/// Start a fresh conversation from Rust: drop the resident's memory, clear the
/// shared transcript, reset the idle clock. The inner body of `new_conversation`,
/// shared with the mission runner (one fresh session per task, Phase 19.1).
pub(crate) fn reset_conversation(app: &AppHandle, session: &AgentSession) {
    // Best-effort: with no resident yet there is nothing to drop, but the UI is
    // still cleared so the reset always gives immediate, honest feedback.
    let _ = write_request(session, &serde_json::json!({ "type": "reset" }));
    clear_conversation(session, app);
    *session.last_activity.lock().unwrap() = None;
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
) -> Result<Option<String>, String> {
    // Stamp when the run was requested (P1.3 ledger); the reply's end time is
    // stamped when it lands. Keep the source/prompt for the record before they are
    // moved into the run request below.
    let started = Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
    let source_rec = source.clone();
    let prompt_rec = prompt.clone();

    // Bring the resident up FIRST - this can block for seconds (spawn + crash
    // backoff). Only once it is live do we claim a turn slot, so a user turn that
    // arrived DURING the spawn is caught by the busy re-check below (B3.3): the
    // scheduler's earlier is_busy() check can go stale across that gap.
    ensure_resident(app, session)?;

    let turn = UNATTENDED_TURN.fetch_add(1, Ordering::Relaxed);
    let (tx, rx): (Sender<TurnMsg>, Receiver<TurnMsg>) = std::sync::mpsc::channel();

    // Re-check busy atomically with claiming the slot (B3.3): if an interactive or
    // mission turn slipped in while the resident was spawning, DEFER rather than
    // preempt the user (serve.ts would cancel their live turn). Unattended runs are
    // serialized by the single scheduler thread, so an empty map here means no other
    // turn is in flight. `Ok(None)` tells the caller to retry on the next tick.
    {
        let mut turns = session.turns.lock().unwrap();
        if !turns.is_empty() || session.pending.lock().unwrap().is_some() {
            return Ok(None);
        }
        turns.insert(turn, tx);
    }

    // Show the run's origin (not the whole prompt) in the shared session log.
    record(session, app, "agent://user", serde_json::json!({ "turn": turn, "text": format!("[{source}]") }));

    let mut req = serde_json::json!({
        "type": "run", "turn": turn, "transcript": prompt, "unattended": true, "source": source,
    });
    if let Some(u) = untrusted {
        req["untrusted"] = serde_json::Value::String(u);
    }

    if let Err(e) = write_request(session, &req) {
        session.turns.lock().unwrap().remove(&turn);
        return Err(e);
    }

    let outcome = await_turn(&rx, WATCHDOG);
    let blocked = drain_blocked(session, turn);
    match outcome {
        Ok(Ok(reply)) => {
            append_run(
                app,
                turn,
                &source_rec,
                &prompt_rec,
                &started,
                &reply.text,
                reply.is_error,
                &blocked,
                reply.usage.as_ref(),
            );
            Ok(Some(reply.text))
        }
        Ok(Err(msg)) => {
            append_run(app, turn, &source_rec, &prompt_rec, &started, &msg, true, &blocked, None);
            Err(msg)
        }
        Err(()) => {
            let msg = "The unattended run did not respond in time.".to_string();
            fail_wedged_turn(app, session, turn, &msg);
            append_run(app, turn, &source_rec, &prompt_rec, &started, &msg, true, &blocked, None);
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
    cancel_turn(session.inner(), turn);
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

/// Cumulative token/cost usage this app session (2.6), for the Diagnostics panel
/// next to the latency percentiles. In-memory, so a restart zeroes it.
#[tauri::command]
pub fn usage_total(session: State<'_, AgentSession>) -> UsageTotals {
    session.usage.lock().unwrap().clone()
}

/// Record which path a voice subsystem went live on, plus any load error (2.7).
/// Called by the widget as each VAD/wake path initializes; last write per
/// subsystem wins. Best-effort - a health write must never disturb voice.
#[tauri::command]
pub fn record_voice_health(session: State<'_, AgentSession>, subsystem: String, status: serde_json::Value) {
    session.voice_health.lock().unwrap().insert(subsystem, status);
}

/// The current voice-stack health for the Diagnostics panel (2.7).
#[tauri::command]
pub fn voice_health(session: State<'_, AgentSession>) -> HashMap<String, serde_json::Value> {
    session.voice_health.lock().unwrap().clone()
}

/// Start a fresh conversation on demand (Phase 11.2 "new conversation", from
/// either face). Tells the resident to drop its memory, clears the shared UI
/// transcript, and resets the idle clock so both windows show an empty session.
#[tauri::command]
pub fn new_conversation(app: AppHandle, session: State<'_, AgentSession>) -> Result<(), String> {
    reset_conversation(&app, session.inner());
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
    crate::fsutil::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    session.request_respawn();
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
    crate::fsutil::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    session.request_respawn();
    Ok(())
}

/// The recent run-ledger records (improvement-5 P1.3), newest first, for the Runs
/// tab. Reads the rolled generation then the current file so history survives a
/// rotation, and caps the count so a long-lived ledger never floods the UI. A
/// missing file reads as no runs (a fresh install shows an empty Runs tab).
#[tauri::command]
pub fn read_runs(app: AppHandle) -> Vec<serde_json::Value> {
    let Ok(dir) = app.path().app_data_dir() else {
        return vec![];
    };
    const KEEP: usize = 200;
    // The current file is newest; only touch the rolled generation if the current
    // one holds fewer than KEEP records (7.6 - avoid parsing a full 4MB).
    let cur = read_tail_lines(&dir.join("june-runs.jsonl"), KEEP);
    let mut lines: Vec<String> = Vec::new();
    if cur.len() < KEEP {
        lines = read_tail_lines(&dir.join("june-runs.jsonl.1"), KEEP - cur.len());
    }
    lines.extend(cur); // [older generation tail ++ current tail], oldest-first
    let mut out: Vec<serde_json::Value> =
        lines.iter().filter_map(|l| serde_json::from_str(l).ok()).collect();
    out.reverse(); // newest first
    out.truncate(KEEP);
    out
}

/// Purge all recorded activity (7.11): the run ledger and the audit log, both
/// generations. These hold verbatim prompts/params (redacted only under on-device
/// privacy modes) indefinitely, and this is the user's explicit "forget what I've
/// done" - invoked from the "Clear recorded activity" button by the privacy picker.
/// Emits `runs://updated` so an open Runs tab empties at once. A missing file is not
/// an error (nothing to clear); a real delete failure is reported so the user knows
/// data may remain.
#[tauri::command]
pub fn clear_recorded_data(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    for name in ["june-runs.jsonl", "june-runs.jsonl.1", "audit.jsonl", "audit.jsonl.1"] {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    let _ = app.emit("runs://updated", ());
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("Could not clear some files: {}", errors.join("; ")))
    }
}

/// Read only the tail of a JSONL ledger, not the whole (up to 2MB) file (7.6):
/// seek to the last WINDOW bytes, drop the (likely truncated) first line when the
/// window didn't reach the start, and keep the last `keep` lines - returned
/// oldest-first (append order) as owned strings ready to JSON-parse.
fn read_tail_lines(path: &std::path::Path, keep: usize) -> Vec<String> {
    // 512KB comfortably holds 200 records (prompt+reply are each capped at 2000
    // chars, and redact to a short marker under on-device modes).
    // ponytail: window, not full file. If 200 maxed records ever exceed 512KB the
    // Runs tab shows slightly fewer - widen WINDOW then.
    const WINDOW: u64 = 512 * 1024;
    let Ok(mut f) = std::fs::File::open(path) else {
        return vec![];
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let partial = len > WINDOW;
    let start = if partial { len - WINDOW } else { 0 };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return vec![];
    }
    tail_lines_from_bytes(&bytes, keep, partial)
}

/// Pure tail extraction (unit-tested without a filesystem): lossy-decode the bytes,
/// drop a leading partial line when `partial` (we seeked mid-record), and keep the
/// last `keep` lines.
fn tail_lines_from_bytes(bytes: &[u8], keep: usize, partial: bool) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if partial && !lines.is_empty() {
        lines.remove(0);
    }
    let start = lines.len().saturating_sub(keep);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

/// Absolute path to the current mission board (improvement-4 Phase 19.1),
/// `<app_data_dir>/june-mission.json`, next to june-memory.md. One host-owned file
/// holding at most one active mission (a voice agent works one mission at a time).
pub(crate) fn mission_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("june-mission.json"))
}

/// Read the current mission board for either face (Phase 19.1). A missing file
/// reads as empty (no active mission), so a fresh install shows a blank board.
#[tauri::command]
pub fn read_mission(app: AppHandle) -> Result<String, String> {
    let path = mission_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist the mission board and broadcast `mission://updated` so BOTH faces show
/// the same board live (Phase 19.1: "both faces can show mission state"). The
/// Rust-side mission runner writes it as tasks progress; the widget renders a
/// compact chip. Written atomically (temp + rename). Clearing is an empty save (no
/// active mission). Unlike memory/lessons this does NOT respawn the resident - the
/// board is UI state, not part of the system prompt.
pub(crate) fn write_mission_inner(app: &AppHandle, content: &str) -> Result<(), String> {
    let path = mission_file(app)?;
    crate::fsutil::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    // Broadcast the new board (parsed, or null when cleared) to every window.
    let payload = serde_json::from_str::<serde_json::Value>(content).unwrap_or(serde_json::Value::Null);
    let _ = app.emit("mission://updated", payload);
    Ok(())
}

/// The webview's write path for the board - today only "Clear mission" (an empty
/// save); the runner itself lives in Rust (improvement-5 P2 5.2).
#[tauri::command]
pub fn write_mission(app: AppHandle, content: String) -> Result<(), String> {
    write_mission_inner(&app, &content)
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

    // Tail parsing (7.6): keep only the last `keep` lines, and when we seeked into
    // the middle of the file (partial=true) the first line is a truncated record
    // that must be dropped, not parsed.
    #[test]
    fn tail_lines_keeps_last_and_drops_partial_leader() {
        let full = b"a\nb\nc\nd\ne\n";
        // Whole file (partial=false): last 3 lines, leader kept.
        assert_eq!(tail_lines_from_bytes(full, 3, false), vec!["c", "d", "e"]);
        // Fewer lines than requested: return them all.
        assert_eq!(tail_lines_from_bytes(full, 99, false), vec!["a", "b", "c", "d", "e"]);
        // Seeked mid-record: the first (truncated) line is dropped before taking the tail.
        let windowed = b"lf-record\nb\nc\nd\ne\n";
        assert_eq!(tail_lines_from_bytes(windowed, 3, true), vec!["c", "d", "e"]);
        // Empty file is empty, either way.
        assert!(tail_lines_from_bytes(b"", 3, true).is_empty());
    }

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

    /// A long-lived child so a test can prove the resident survives (or is killed).
    /// Killed by `shutdown()` at the end of each test; never runs to completion.
    fn dummy_resident() -> Resident {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping", "-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn dummy child");
        let stdin = child.stdin.take().unwrap();
        Resident { stdin, child, gen: 1 }
    }

    #[test]
    fn config_change_while_busy_defers_the_respawn_and_spares_the_child() {
        let session = AgentSession::default();
        *session.resident.lock().unwrap() = Some(dummy_resident());

        // A registered turn == busy (B2.2: the just-sent command's turn).
        let (tx, _rx) = std::sync::mpsc::channel();
        session.turns.lock().unwrap().insert(1, tx);
        assert!(session.is_busy());

        // A settings save (or learned correction) while busy must NOT kill the child.
        session.request_respawn();
        assert!(session.respawn_pending.load(Ordering::Relaxed), "respawn should be deferred");
        assert!(
            session
                .resident
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .child
                .try_wait()
                .unwrap()
                .is_none(),
            "the in-flight turn's resident was killed by a mid-turn config change"
        );

        // Turn done -> the deferred respawn lands, dropping the stale resident.
        session.turns.lock().unwrap().remove(&1);
        apply_pending_respawn(&session);
        assert!(!session.respawn_pending.load(Ordering::Relaxed));
        assert!(session.resident.lock().unwrap().is_none(), "idle: deferred respawn should apply");

        // Idle path unchanged: a config change with no turn in flight kills at once.
        *session.resident.lock().unwrap() = Some(dummy_resident());
        session.request_respawn();
        assert!(session.resident.lock().unwrap().is_none(), "idle: respawn should be immediate");
    }

    #[test]
    fn await_turn_extends_on_activity_but_times_out_on_silence() {
        use std::sync::mpsc::channel;
        // Activity pings keep the turn alive well past a single idle window (total
        // span 240ms > 120ms idle), then `Done` delivers the reply (B3.2).
        let (tx, rx) = channel::<TurnMsg>();
        let idle = Duration::from_millis(120);
        let h = std::thread::spawn(move || {
            for _ in 0..4 {
                std::thread::sleep(Duration::from_millis(60)); // each gap < idle
                let _ = tx.send(TurnMsg::Activity);
            }
            let _ = tx.send(TurnMsg::Done(Ok(TurnReply { text: "hi".into(), is_error: false, usage: None })));
        });
        let out = await_turn(&rx, idle).expect("activity should extend the deadline");
        assert_eq!(out.unwrap().text, "hi");
        h.join().unwrap();

        // True silence past the idle window times out - the watchdog still fires.
        let (_tx, rx2) = channel::<TurnMsg>();
        assert!(await_turn(&rx2, Duration::from_millis(50)).is_err());
    }

    #[test]
    fn backoff_delay_is_capped_and_grows() {
        assert_eq!(backoff_delay(0), Duration::from_millis(250));
        assert_eq!(backoff_delay(1), Duration::from_millis(500));
        // Capped at 8s no matter how many failures.
        assert_eq!(backoff_delay(20), Duration::from_millis(8_000));
    }
}
