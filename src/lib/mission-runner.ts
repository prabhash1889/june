import { invoke } from "@tauri-apps/api/core";

import {
  advanceMission,
  type Mission,
  newMission,
  parseTaskList,
  parseVerdict,
  retryPrompt,
  stopMission,
  verifyPrompt,
} from "./missions.ts";
import { cancelAgent, missionTurnBase, newConversation, readMission, writeMission } from "./session.ts";

// The mission runner as a module-level singleton (improvement-5 P0.3). It used to
// live inside the MissionBoard component, where a tab switch unmounted the board
// and orphaned the running loop: Stop disappeared, "Start mission" re-armed (so a
// second mission could run concurrently), and closing the window killed the loop
// outright while the persisted board stayed "active" forever - pinning the widget
// card open with no way to clear it. Here the loop outlives the component; the
// board just subscribes.
//
// Every task still runs through the same execution-layer gate as an interactive
// turn (Phase 19.1) - a mission is not a bypass.

// Turn-number space for mission runs (B3.7): seeded from a monotonic per-load base
// above the widget's interactive band and below the unattended space at 2^40, so a
// webview reload never reuses a number still registered in the shared Rust map.
let missionTurn = missionTurnBase();

const decomposePrompt = (outcome: string): string =>
  "Break this outcome into a short, ordered checklist of concrete tasks, each doable on its own. " +
  "Reply with ONLY a numbered list - one task per line, no preamble, no closing remarks.\n\n" +
  `Outcome: ${outcome}`;

/** One turn's structured reply from the Rust `run_agent` command (B3.4). */
type TurnReply = { text: string; isError: boolean };

export interface RunnerState {
  running: boolean;
  error: string | null;
}

// Snapshot object is replaced (never mutated) so useSyncExternalStore sees a new
// reference exactly when the state changed.
let state: RunnerState = { running: false, error: null };
const listeners = new Set<() => void>();

function setState(next: Partial<RunnerState>): void {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export function subscribeRunner(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function runnerState(): RunnerState {
  return state;
}

let cancelled = false;
let activeTurn = 0;
// The latest persisted board, so Stop can close it without a stale copy.
let working: Mission | null = null;

async function persist(m: Mission | null): Promise<void> {
  working = m;
  await writeMission(m);
}

/** Dispatch one prompt as its own fresh session (Phase 19.1 "sequential sessions
 *  per task"). Returns the turn reply, or null if the invoke threw (hard failure). */
async function dispatch(prompt: string): Promise<TurnReply | null> {
  await newConversation(); // a fresh session so tasks/verify don't bleed context
  activeTurn = missionTurn++;
  try {
    return await invoke<TurnReply>("run_agent", { transcript: prompt, turn: activeTurn });
  } catch {
    return null;
  }
}

/** The verification turn (P1.4): grade whether a task actually succeeded. A failed
 *  or errored verification reads as FAIL, so a task is never marked done on a murky
 *  reply. */
async function verify(outcome: string, title: string): Promise<{ pass: boolean; reason: string }> {
  const v = await dispatch(verifyPrompt(outcome, title));
  if (!v || v.isError) return { pass: false, reason: "Verification could not be completed." };
  return parseVerdict(v.text);
}

/** Run one task with the mission loop (P1.4): attempt it, optionally verify, and on
 *  FAIL retry once with the failure reason as context, then re-verify. Returns the
 *  final outcome plus a note explaining a failure for the board. */
async function runTask(outcome: string, title: string, doVerify: boolean): Promise<{ ok: boolean; note?: string }> {
  const first = await dispatch(title);
  if (cancelled) return { ok: false };
  let reason: string;
  if (first && !first.isError) {
    if (!doVerify) return { ok: true };
    const verdict = await verify(outcome, title);
    if (cancelled) return { ok: false };
    if (verdict.pass) return { ok: true };
    reason = verdict.reason;
  } else {
    reason = "The first attempt reported an error.";
  }

  // One retry with the failure context (P1.4).
  const retry = await dispatch(retryPrompt(title, reason));
  if (cancelled) return { ok: false };
  if (!retry || retry.isError) return { ok: false, note: reason };
  if (!doVerify) return { ok: true };
  const verdict = await verify(outcome, title);
  if (cancelled) return { ok: false };
  return verdict.pass ? { ok: true } : { ok: false, note: verdict.reason || reason };
}

/** Run a mission end to end: decompose the outcome into tasks, then run each with
 *  the mission loop (attempt → verify → retry, P1.4), advancing the shared board
 *  after each. Stops early when `cancelled` flips. */
async function runMission(outcome: string, doVerify: boolean): Promise<void> {
  // Decompose in a FRESH conversation (B3.6) so leftover context from a prior chat
  // doesn't contaminate the plan (tasks already each get their own session below).
  await newConversation();
  activeTurn = missionTurn++;
  const listReply = await invoke<TurnReply>("run_agent", { transcript: decomposePrompt(outcome), turn: activeTurn });
  if (cancelled) return;
  let mission = newMission(outcome, parseTaskList(listReply.text));
  if (!mission) throw new Error("I couldn't break that outcome into tasks. Try rephrasing it.");
  await persist(mission);

  // Dispatch in list order; advanceMission walks the active pointer to match.
  for (let i = 0; i < mission.tasks.length; i++) {
    if (cancelled) return;
    const { ok, note } = await runTask(mission.outcome, mission.tasks[i].title, doVerify);
    if (cancelled) return; // stopped during the run: Stop already closed the board
    mission = advanceMission(mission, ok, note);
    await persist(mission);
  }
}

/** Start a mission. A no-op while one is already running - the double-start guard
 *  lives here, not in component state, so a remounted board can't re-arm it.
 *  `doVerify` (P1.4) turns on the per-task verify → retry loop. */
export async function startMission(outcome: string, doVerify = true): Promise<void> {
  const o = outcome.trim();
  if (!o || state.running) return;
  cancelled = false;
  setState({ running: true, error: null });
  try {
    await runMission(o, doVerify);
  } catch (e) {
    // A user Stop is not an error to surface; a real failure is.
    if (!cancelled) setState({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    setState({ running: false });
  }
}

/** Stop the running mission (B3.5): cancel the in-flight turn so it stops spending
 *  tokens, and close the board to `failed` so Clear renders. */
export function stopRunningMission(): void {
  cancelled = true;
  void cancelAgent(activeTurn);
  if (working && working.status === "active") void persist(stopMission(working));
}

/** Close a board left "active" by a runner that no longer exists: the app window
 *  was closed (or reloaded) mid-mission, killing the loop in this webview while
 *  the persisted board still said active - which also pins the widget card open.
 *  Called on app-window mount; a live runner (or no board) makes it a no-op. */
export async function recoverInterruptedMission(): Promise<void> {
  const m = await readMission();
  if (!m || m.status !== "active" || state.running) return;
  await writeMission(stopMission(m));
}
