// The mission runner, in Rust (improvement-5 P2 5.2). The webview-side runner
// (P0.3's module singleton) was a stopgap: it died with its webview, so closing
// or reloading the app window killed a mission mid-flight. This thread survives
// any webview, resumes an `active` board on startup, and schedules around
// interactive turns instead of colliding with them.
//
// Division of labour with the webview (5.3 plan -> confirm):
//   - The MissionBoard decomposes the outcome via a normal interactive turn and
//     shows the task list for the user to confirm or edit.
//   - `start_mission` receives the CONFIRMED titles, builds the board, persists
//     it, and drives the tasks from a background thread: one fresh session per
//     task, attempt -> verify -> retry (P1.4), a capped digest of prior replies
//     as context (5.1), advancing the shared board after each.
//   - While a mission names a toolset (5.4), the session's MCP filter keeps only
//     those generic servers in the resident's env; restored when it ends.
//
// Every task runs through the same execution-layer approval gate as an
// interactive turn (Phase 19.1) - a mission is not a bypass.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::agent_runner::{
    append_run, cancel_turn, cap_chars, read_mission, reset_conversation, run_attended,
    write_mission_inner, AgentSession, TurnReply,
};

/// Turn-number space for mission runs: the [2^39, 2^40) band between the widget's
/// interactive turns and the unattended space (B3.7). Owned by this Rust-side
/// runner now, so it is monotonic for the app session and never collides.
static MISSION_TURN: AtomicU64 = AtomicU64::new(1 << 39);

/// Cap on how many tasks a mission can hold (mirrors missions.ts::MAX_TASKS), so
/// a runaway plan can't spawn hundreds of sequential paid runs.
const MAX_TASKS: usize = 12;

/// Chars of one prior task's reply carried into the next task's context (5.1).
const CONTEXT_REPLY_CAP: usize = 600;
/// Total chars of prior-task context, so a long mission can't balloon a prompt.
const CONTEXT_TOTAL_CAP: usize = 2400;

fn default_verify() -> bool {
    true
}
fn pending() -> String {
    "pending".into()
}
fn active() -> String {
    "active".into()
}

/// One task on the board. Statuses are the strings the webview renders:
/// pending | active | done | failed (missions.ts::TaskStatus).
#[derive(Clone, Serialize, Deserialize)]
pub struct MissionTask {
    #[serde(default)]
    id: String,
    title: String,
    #[serde(default = "pending")]
    status: String,
    /// Why a task failed (P1.4): the verification turn's reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// The persisted board (june-mission.json), the same shape missions.ts coerces
/// for display. `verify` is Rust-only bookkeeping (ignored by the webview) so a
/// resumed mission keeps its verify -> retry choice.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    #[serde(default)]
    id: String,
    #[serde(default)]
    outcome: String,
    tasks: Vec<MissionTask>,
    #[serde(default = "active")]
    status: String,
    #[serde(default)]
    toolset_ids: Vec<String>,
    #[serde(default = "default_verify")]
    verify: bool,
}

/// The Rust-side runner state, `.manage`d by Tauri. One mission at a time (a
/// voice agent works one mission at a time); `running` is the double-start guard,
/// `cancelled` is Stop's flag, `active_turn` lets Stop abort the in-flight turn,
/// `paused` (5.3) holds the board BETWEEN tasks without failing anything.
#[derive(Default, Clone)]
pub struct MissionRunner {
    running: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    active_turn: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
}

impl MissionRunner {
    /// Whether a mission is currently running (the double-start guard, read-only).
    /// The scheduler checks this before consuming a voice-started mission request
    /// (4.10) so it never drops one against an already-busy runner.
    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// A voice-started mission request (improvement-6 4.10), the shape the automation
/// MCP server writes to settings.json (`pendingMissions`). camelCase to match the
/// TS-written JSON (toolsetIds). The scheduler pops one per tick and starts it via
/// the same path as the `start_mission` command.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMission {
    pub outcome: String,
    pub tasks: Vec<String>,
    #[serde(default)]
    pub toolset_ids: Vec<String>,
    #[serde(default = "default_verify")]
    pub verify: bool,
}

// --- Pure board logic (ported from missions.ts, unit-tested below) ----------

fn active_index(m: &Mission) -> Option<usize> {
    m.tasks.iter().position(|t| t.status == "active")
}

/// Advance the board after the active task ran: mark it done/failed (with an
/// optional reason note, P1.4), then activate the next pending task. When none
/// remain, the mission finishes - failed if any task failed, else done.
fn advance(m: &mut Mission, ok: bool, note: Option<String>) {
    let Some(i) = active_index(m) else { return };
    m.tasks[i].status = if ok { "done" } else { "failed" }.into();
    if !ok {
        if let Some(n) = note {
            let n = n.trim();
            if !n.is_empty() {
                m.tasks[i].note = Some(n.to_string());
            }
        }
    }
    if let Some(next) = m.tasks.iter().position(|t| t.status == "pending") {
        m.tasks[next].status = "active".into();
        m.status = "active".into();
    } else {
        m.status = if m.tasks.iter().any(|t| t.status == "failed") {
            "failed"
        } else {
            "done"
        }
        .into();
    }
}

/// Stop a mission in flight (B3.5): fail the active task and close the board so
/// the Clear button renders. A no-op if nothing is active.
fn stop_board(m: &mut Mission) {
    if active_index(m).is_none() {
        return;
    }
    for t in &mut m.tasks {
        if t.status == "active" {
            t.status = "failed".into();
        }
    }
    m.status = "failed".into();
}

/// The first non-empty line of `text`, capped, as a one-sentence reason.
fn first_line(text: &str) -> String {
    cap_chars(text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(""), 200)
}

fn or_default(reason: String) -> String {
    if reason.is_empty() {
        "The task did not pass verification.".into()
    } else {
        reason
    }
}

/// Parse a verification turn's reply into PASS/FAIL + a reason (P1.4, ported from
/// missions.ts::parseVerdict). Conservative: PASS only on an explicit PASS with no
/// FAIL, so an ambiguous verdict fails the task (and triggers the retry) rather
/// than marking murky work done.
fn parse_pass(text: &str) -> (bool, String) {
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches(|c: char| !c.is_ascii_alphabetic());
        let up = line.to_ascii_uppercase();
        let word = |w: &str| {
            up.starts_with(w) && !up.as_bytes().get(w.len()).is_some_and(|b| b.is_ascii_alphanumeric())
        };
        if word("PASS") {
            return (true, first_line(line));
        }
        if word("FAIL") {
            return (false, or_default(first_line(line)));
        }
    }
    let up = text.to_ascii_uppercase();
    let pass = up.contains("PASS") && !up.contains("FAIL");
    (pass, or_default(first_line(text)))
}

/// The verification-turn prompt (P1.4): grade whether the task actually succeeded.
fn verify_prompt(outcome: &str, task: &str) -> String {
    format!(
        "You just attempted this task, part of the goal \"{}\":\n\n{}\n\nCheck whether it actually \
         succeeded - use tools to look if you can. Reply with the single word PASS or FAIL on the \
         first line, then one short sentence explaining why.",
        outcome.trim(),
        task.trim()
    )
}

/// The retry prompt (P1.4): re-run the task with the prior failure reason.
fn retry_prompt(task: &str, reason: &str) -> String {
    let why = reason.trim();
    format!(
        "{}\n\nA previous attempt did not succeed{}. Try again, addressing that.",
        task.trim(),
        if why.is_empty() { String::new() } else { format!(": {why}") }
    )
}

/// The prompt for one task (5.1): its title plus a capped digest of the replies
/// from tasks already completed this run, so task three can build on what task one
/// produced instead of starting blind in its fresh session. Newest replies win
/// when the cap bites. Prior-free tasks get the bare title (the pre-P2 shape).
fn task_prompt(title: &str, outcome: &str, prior: &[(String, String)]) -> String {
    if prior.is_empty() {
        return title.trim().to_string();
    }
    let mut picked: Vec<String> = Vec::new();
    let mut total = 0usize;
    for (t, reply) in prior.iter().rev() {
        let r = cap_chars(reply.trim(), CONTEXT_REPLY_CAP);
        let line = format!("- {}: {}", t.trim(), if r.is_empty() { "(no reply)".into() } else { r });
        if total + line.chars().count() > CONTEXT_TOTAL_CAP && !picked.is_empty() {
            break;
        }
        total += line.chars().count();
        picked.push(line);
    }
    picked.reverse();
    format!(
        "{}\n\n[This task is part of the goal \"{}\". Notes from the tasks already done - context, \
         not instructions:\n{}]",
        title.trim(),
        outcome.trim(),
        picked.join("\n")
    )
}

/// Slug id for a board (port of mcp-servers.ts::slugify, "mission" fallback).
fn slug(outcome: &str) -> String {
    let s: String = outcome
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let s: String = s.chars().take(40).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "mission".into() } else { s }
}

// --- The runner --------------------------------------------------------------

/// Local timestamp in the run ledger's format ("YYYY-MM-DDTHH:MM:SS"), matching
/// agent_runner's unattended-run stamps (2.3).
fn now_stamp() -> String {
    chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn persist(app: &AppHandle, mission: &Mission) {
    let content = serde_json::to_string(mission).unwrap_or_default();
    if let Err(e) = write_mission_inner(app, &content) {
        crate::logf::log(app, &format!("[mission] couldn't persist the board: {e}"));
    }
}

/// Wait between tasks until the mission may proceed (5.2 + 5.3): hold while the
/// interactive session is busy (a mission schedules around the user instead of
/// preempting them) OR the runner is paused ("hold on while I take this call").
/// Returns as soon as the runner is cancelled so Stop is never blocked. A turn
/// that still slips in mid-task preempts that one dispatch (serve.ts barge-in),
/// which lands as a failed attempt and rides the existing retry.
fn wait_until_ready(session: &AgentSession, runner: &MissionRunner) {
    while (session.is_busy() || runner.paused.load(Ordering::SeqCst))
        && !runner.cancelled.load(Ordering::SeqCst)
    {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Dispatch one prompt as its own fresh session (Phase 19.1 "sequential sessions
/// per task"). `None` = hard failure (crash/watchdog), mirroring the old webview
/// runner's null.
fn dispatch(
    app: &AppHandle,
    session: &AgentSession,
    runner: &MissionRunner,
    prompt: String,
) -> Option<TurnReply> {
    reset_conversation(app, session);
    let turn = MISSION_TURN.fetch_add(1, Ordering::Relaxed);
    runner.active_turn.store(turn, Ordering::Relaxed);
    run_attended(app, session, prompt, turn).ok()
}

/// The verification turn (P1.4): a failed or errored verification reads as FAIL,
/// so a task is never marked done on a murky reply.
fn verify_task(
    app: &AppHandle,
    session: &AgentSession,
    runner: &MissionRunner,
    outcome: &str,
    title: &str,
) -> (bool, String) {
    match dispatch(app, session, runner, verify_prompt(outcome, title)) {
        Some(r) if !r.is_error => parse_pass(&r.text),
        _ => (false, "Verification could not be completed.".into()),
    }
}

/// One task through the mission loop (P1.4): attempt -> optional verify -> one
/// retry with the failure reason -> re-verify. Returns (ok, note-for-the-board,
/// reply-for-the-next-task's-context).
fn run_task(
    app: &AppHandle,
    session: &AgentSession,
    runner: &MissionRunner,
    outcome: &str,
    title: &str,
    verify: bool,
    prior: &[(String, String)],
) -> (bool, Option<String>, Option<String>) {
    let cancelled = || runner.cancelled.load(Ordering::SeqCst);
    let first = dispatch(app, session, runner, task_prompt(title, outcome, prior));
    if cancelled() {
        return (false, None, None);
    }
    let reason = match first {
        Some(r) if !r.is_error => {
            if !verify {
                return (true, None, Some(r.text));
            }
            let (pass, why) = verify_task(app, session, runner, outcome, title);
            if cancelled() {
                return (false, None, None);
            }
            if pass {
                return (true, None, Some(r.text));
            }
            why
        }
        _ => "The first attempt reported an error.".to_string(),
    };

    // One retry with the failure context (P1.4).
    let retry = dispatch(app, session, runner, retry_prompt(title, &reason));
    if cancelled() {
        return (false, None, None);
    }
    match retry {
        Some(r) if !r.is_error => {
            if !verify {
                return (true, None, Some(r.text));
            }
            let (pass, why) = verify_task(app, session, runner, outcome, title);
            if cancelled() {
                return (false, None, None);
            }
            if pass {
                (true, None, Some(r.text))
            } else {
                (false, Some(if why.is_empty() { reason } else { why }), None)
            }
        }
        _ => (false, Some(reason), None),
    }
}

/// Drive the whole board: wait for idle, run each task through the mission loop,
/// advance and persist after each. Stops early when Stop flips `cancelled` (Stop
/// already closed the board, so no further writes happen here).
fn run_board(app: &AppHandle, session: &AgentSession, runner: &MissionRunner, mut mission: Mission) {
    // Composable toolsets (5.4): while this mission runs, only its named generic
    // servers ride into the resident's env. The respawn is deferred if a turn is
    // in flight; ensure_resident applies it at the next dispatch.
    let filtered = !mission.toolset_ids.is_empty();
    if filtered {
        session.set_mcp_filter(Some(mission.toolset_ids.clone()));
        session.request_respawn();
    }
    let mut prior: Vec<(String, String)> = Vec::new();
    while let Some(i) = active_index(&mission) {
        if runner.cancelled.load(Ordering::SeqCst) {
            break;
        }
        wait_until_ready(session, runner);
        if runner.cancelled.load(Ordering::SeqCst) {
            break;
        }
        let title = mission.tasks[i].title.clone();
        let started = now_stamp();
        let (ok, note, reply) =
            run_task(app, session, runner, &mission.outcome, &title, mission.verify, &prior);
        if runner.cancelled.load(Ordering::SeqCst) {
            break;
        }
        // Record this task in the run ledger (2.3): missions used to bypass
        // append_run entirely, so "Clear mission" destroyed the only record a
        // mission ever ran - including failure notes. Each task lands as its own
        // ledger entry with the verify verdict (the failure note) as the reply, so
        // the Runs tab keeps a durable history. `active_turn` is the last turn this
        // task dispatched - monotonic in the mission band, so a stable unique id.
        let ledger_reply = if ok { reply.clone().unwrap_or_default() } else { note.clone().unwrap_or_default() };
        let run_id = runner.active_turn.load(Ordering::Relaxed);
        // ponytail: mission `dispatch` returns only text/error, not the TurnReply,
        // so no per-task usage rides into the ledger here. The session-wide total
        // (2.6) still counts these turns via the `final` accumulator; thread a
        // TurnReply through run_task only if per-mission-task cost is ever wanted.
        append_run(
            app,
            run_id,
            &format!("mission: {}", mission.outcome),
            &title,
            &started,
            &ledger_reply,
            !ok,
            &[],
            None,
        );
        if ok {
            if let Some(r) = reply {
                prior.push((title, r));
            }
        }
        advance(&mut mission, ok, note);
        persist(app, &mission);
    }
    // Single writer for the board (5.4): if Stop cancelled us, THIS thread writes
    // the terminal (failed) board - Stop only sets the flag. That closes the race
    // where Stop's own read-modify-write from the command thread could interleave
    // with this thread's per-task persist and resurrect a stopped board. On a
    // normal finish `advance` already drove the board terminal and persisted it.
    if runner.cancelled.load(Ordering::SeqCst) {
        stop_board(&mut mission);
        persist(app, &mission);
    }
    if filtered {
        // Restore the full tool surface for the next interactive turn.
        session.set_mcp_filter(None);
        session.request_respawn();
    }
}

/// Claim the runner and spawn the board thread. `persist_first` writes the fresh
/// board before the thread starts so the UI shows it immediately.
fn spawn(
    app: AppHandle,
    session: AgentSession,
    runner: MissionRunner,
    mission: Mission,
    persist_first: bool,
) -> Result<(), String> {
    if runner.running.swap(true, Ordering::SeqCst) {
        return Err("A mission is already running.".to_string());
    }
    runner.cancelled.store(false, Ordering::SeqCst);
    // A fresh mission never inherits a stale pause (5.3); tell any open board too.
    runner.paused.store(false, Ordering::SeqCst);
    let _ = app.emit("mission://paused", false);
    if persist_first {
        let content = serde_json::to_string(&mission).map_err(|e| e.to_string())?;
        if let Err(e) = write_mission_inner(&app, &content) {
            runner.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    }
    std::thread::spawn(move || {
        run_board(&app, &session, &runner, mission);
        runner.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Start a mission from a CONFIRMED plan (5.3): the webview decomposed the outcome
/// and the user confirmed or edited the task list; this builds the board and
/// drives it from Rust. Errs when a mission is already running (double-start
/// guard) or the plan is empty.
#[tauri::command]
pub fn start_mission(
    app: AppHandle,
    session: State<'_, AgentSession>,
    runner: State<'_, MissionRunner>,
    outcome: String,
    tasks: Vec<String>,
    toolset_ids: Vec<String>,
    verify: bool,
) -> Result<(), String> {
    start_mission_from(
        app,
        session.inner().clone(),
        runner.inner().clone(),
        outcome,
        tasks,
        toolset_ids,
        verify,
    )
}

/// Build a board from a confirmed plan and drive it, without the Tauri `State`
/// wrapper - so both the `start_mission` command (webview plan-confirm) and the
/// scheduler's voice-started path (4.10) share the exact same start logic. Trims/
/// caps the tasks and dedupes the toolset. Errs on an empty plan or a mission
/// already running (spawn's double-start guard).
pub(crate) fn start_mission_from(
    app: AppHandle,
    session: AgentSession,
    runner: MissionRunner,
    outcome: String,
    tasks: Vec<String>,
    toolset_ids: Vec<String>,
    verify: bool,
) -> Result<(), String> {
    let titles: Vec<String> = tasks
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .take(MAX_TASKS)
        .collect();
    if titles.is_empty() {
        return Err("There are no tasks to run.".to_string());
    }
    let outcome = outcome.trim().to_string();
    let mut ids: Vec<String> = Vec::new();
    for id in toolset_ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mission = Mission {
        id: slug(&outcome),
        outcome,
        tasks: titles
            .into_iter()
            .enumerate()
            .map(|(i, title)| MissionTask {
                id: format!("t{i}"),
                title,
                status: if i == 0 { "active" } else { "pending" }.into(),
                note: None,
            })
            .collect(),
        status: "active".into(),
        toolset_ids: ids,
        verify,
    };
    spawn(app, session, runner, mission, true)
}

/// Stop the running mission (B3.5, now Rust-side): flag the runner and abort the
/// in-flight turn so it stops spending tokens. The board's terminal (failed) write
/// is the RUNNER thread's job (5.4 single writer) - it sees `cancelled` and closes
/// the board itself, so Stop's flag can't interleave with a per-task persist and
/// resurrect a stopped board. Clearing pause lets a paused mission's loop wake and
/// reach that terminal write. Only when NO runner thread is alive (a stale `active`
/// board left by a dead session) does Stop close the board here - no competing
/// writer then, so the read-modify-write is safe.
#[tauri::command]
pub fn stop_mission(
    app: AppHandle,
    session: State<'_, AgentSession>,
    runner: State<'_, MissionRunner>,
) -> Result<(), String> {
    runner.cancelled.store(true, Ordering::SeqCst);
    runner.paused.store(false, Ordering::SeqCst); // wake a paused loop so it can close out
    let _ = app.emit("mission://paused", false);
    let turn = runner.active_turn.load(Ordering::Relaxed);
    if turn != 0 {
        cancel_turn(session.inner(), turn);
    }
    if !runner.running() {
        if let Ok(raw) = read_mission(app.clone()) {
            if let Ok(mut mission) = serde_json::from_str::<Mission>(&raw) {
                if mission.status == "active" {
                    stop_board(&mut mission);
                    persist(&app, &mission);
                }
            }
        }
    }
    Ok(())
}

/// Pause or resume the running mission (5.3): a paused runner holds BETWEEN tasks
/// (an in-flight task finishes; the next won't start until resumed) so "hold on
/// while I take this call" costs nothing - unlike Stop, which fails the active
/// task. The board stays `active` and persisted; `mission://paused` tells both
/// faces to reflect the pause. A no-op-safe flag flip either way.
#[tauri::command]
pub fn set_mission_paused(app: AppHandle, runner: State<'_, MissionRunner>, paused: bool) {
    runner.paused.store(paused, Ordering::SeqCst);
    let _ = app.emit("mission://paused", paused);
}

/// Whether the mission is paused (5.3), for a surface seeding on mount before any
/// `mission://paused` event arrives.
#[tauri::command]
pub fn mission_paused(runner: State<'_, MissionRunner>) -> bool {
    runner.paused.load(Ordering::SeqCst)
}

/// Resume an `active` board on startup (5.2): the previous app session died (or
/// was quit) mid-mission, so re-run the task that was active and carry on -
/// replacing P0.3's "mark it failed on mount" recovery with the real thing. A
/// board with nothing runnable is closed out so it can't pin the widget open.
pub fn resume(app: AppHandle, session: AgentSession, runner: MissionRunner) {
    let Ok(raw) = read_mission(app.clone()) else { return };
    if raw.trim().is_empty() {
        return;
    }
    let Ok(mut mission) = serde_json::from_str::<Mission>(&raw) else { return };
    if mission.status != "active" {
        return;
    }
    if active_index(&mission).is_none() {
        // No active task: activate the next pending one, or close a spent board.
        if let Some(next) = mission.tasks.iter().position(|t| t.status == "pending") {
            mission.tasks[next].status = "active".into();
        } else {
            mission.status = if mission.tasks.iter().any(|t| t.status == "failed") {
                "failed"
            } else {
                "done"
            }
            .into();
            persist(&app, &mission);
            return;
        }
    }
    let _ = spawn(app, session, runner, mission, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(titles: &[&str]) -> Mission {
        Mission {
            id: "m".into(),
            outcome: "do it".into(),
            tasks: titles
                .iter()
                .enumerate()
                .map(|(i, t)| MissionTask {
                    id: format!("t{i}"),
                    title: (*t).into(),
                    status: if i == 0 { "active" } else { "pending" }.into(),
                    note: None,
                })
                .collect(),
            status: "active".into(),
            toolset_ids: vec![],
            verify: true,
        }
    }

    #[test]
    fn advance_walks_tasks_to_done_on_all_success() {
        let mut m = board(&["a", "b"]);
        advance(&mut m, true, None);
        assert_eq!(m.status, "active");
        assert_eq!(active_index(&m), Some(1));
        advance(&mut m, true, None);
        assert_eq!(m.status, "done");
        assert!(active_index(&m).is_none());
    }

    #[test]
    fn advance_finishes_failed_but_still_works_remaining_tasks() {
        let mut m = board(&["a", "b"]);
        advance(&mut m, false, Some("the file was not written".into()));
        assert_eq!(m.status, "active"); // keeps going
        assert_eq!(m.tasks[0].note.as_deref(), Some("the file was not written"));
        advance(&mut m, true, Some("ignored on success".into()));
        assert_eq!(m.status, "failed");
        assert!(m.tasks[1].note.is_none());
    }

    #[test]
    fn stop_board_fails_the_active_task_and_closes_the_mission() {
        let mut m = board(&["a", "b", "c"]);
        advance(&mut m, true, None); // a done, b active
        stop_board(&mut m);
        assert_eq!(m.status, "failed");
        let statuses: Vec<&str> = m.tasks.iter().map(|t| t.status.as_str()).collect();
        assert_eq!(statuses, ["done", "failed", "pending"]);
        // A finished board is untouched.
        let mut done = board(&["a"]);
        advance(&mut done, true, None);
        let before = serde_json::to_string(&done).unwrap();
        stop_board(&mut done);
        assert_eq!(serde_json::to_string(&done).unwrap(), before);
    }

    #[test]
    fn parse_pass_reads_explicit_verdicts_and_fails_conservatively() {
        assert!(parse_pass("PASS\nThe tests all ran green.").0);
        let (ok, reason) = parse_pass("FAIL - the changelog was not updated.");
        assert!(!ok);
        assert!(reason.contains("changelog"));
        // Ambiguous / errored verdicts fail (and trigger the retry).
        assert!(!parse_pass("I could not tell if it worked.").0);
        assert!(!parse_pass("It both passed and failed in parts.").0);
        assert!(!parse_pass("").0);
        // An unqualified pass mention is a pass; PASSING (no word boundary) is not
        // an explicit first-line verdict but still counts in the whole-reply scan.
        assert!(parse_pass("Everything looks good, this is a PASS.").0);
    }

    #[test]
    fn prompts_carry_outcome_task_and_reason() {
        let v = verify_prompt("ship the release", "run the tests");
        assert!(v.contains("ship the release"));
        assert!(v.contains("run the tests"));
        assert!(v.contains("PASS or FAIL"));
        assert!(retry_prompt("run the tests", "two tests errored").contains("two tests errored"));
        assert!(retry_prompt("run the tests", "").contains("Try again"));
    }

    #[test]
    fn task_prompt_digests_prior_replies_with_caps() {
        // No prior context: the bare title, the pre-P2 shape.
        assert_eq!(task_prompt(" write the summary ", "goal", &[]), "write the summary");
        let prior = vec![
            ("read the notes".to_string(), "The notes say X.".to_string()),
            ("draft the outline".to_string(), "Outline: A, B, C.".to_string()),
        ];
        let p = task_prompt("write the summary", "summarize my notes", &prior);
        assert!(p.starts_with("write the summary"));
        assert!(p.contains("summarize my notes"));
        assert!(p.contains("read the notes: The notes say X."));
        assert!(p.contains("draft the outline: Outline: A, B, C."));
        // The total cap keeps the NEWEST replies when it bites.
        let long: Vec<(String, String)> = (0..10)
            .map(|i| (format!("t{i}"), "x".repeat(CONTEXT_REPLY_CAP)))
            .collect();
        let capped = task_prompt("final task", "goal", &long);
        assert!(capped.contains("t9"));
        assert!(!capped.contains("t0:"));
        assert!(capped.chars().count() < CONTEXT_TOTAL_CAP + CONTEXT_REPLY_CAP + 200);
    }

    #[test]
    fn mission_serde_matches_the_webview_shape() {
        let m = board(&["a"]);
        let json = serde_json::to_string(&m).unwrap();
        // camelCase toolsetIds, statuses as strings - what missions.ts coerces.
        assert!(json.contains("\"toolsetIds\":[]"));
        assert!(json.contains("\"status\":\"active\""));
        // A webview-era board (no verify field) still parses, defaulting verify on.
        let legacy = r#"{"id":"m","outcome":"o","status":"active","toolsetIds":[],
            "tasks":[{"id":"t0","title":"a","status":"active"}]}"#;
        let parsed: Mission = serde_json::from_str(legacy).unwrap();
        assert!(parsed.verify);
        assert_eq!(active_index(&parsed), Some(0));
    }

    #[test]
    fn slug_is_bounded_and_never_empty() {
        assert_eq!(slug("Ship the Release!"), "ship-the-release");
        assert_eq!(slug("!!!"), "mission");
        assert!(slug(&"x".repeat(100)).len() <= 40);
    }
}
