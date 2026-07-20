// Missions & platform completion (improvement-4 Phase 19.1/19.2). A user states an
// OUTCOME; June decomposes it into a verifiable task list and works the tasks one
// per session, updating a task board both faces can watch.
//
// This module is the pure, tauri-free, SDK-free core: the shapes, the
// decomposition-list parser, the board state machine, and the composable-toolset
// selector (19.2). The live orchestration (decompose via the brain, dispatch each
// task as its own run) lives in the app UI; persistence + cross-window broadcast
// live in Rust. So the risky logic here is unit-tested without a brain, a file, or
// a window - the same discipline as schedules.ts / mcp-servers.ts.

import { type McpServerEntry, slugify } from "./mcp-servers.ts";

export type TaskStatus = "pending" | "active" | "done" | "failed";

export interface MissionTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Why a task failed (improvement-5 P1.4): the verification turn's reason, shown
   *  under the task so a failed board explains itself. Absent unless failed. */
  note?: string;
}

export type MissionStatus = "active" | "done" | "failed";

export interface Mission {
  id: string;
  /** The user-stated outcome the tasks add up to. */
  outcome: string;
  tasks: MissionTask[];
  status: MissionStatus;
  /** Server ids relevant to this mission (19.2 composable toolsets). Empty = all
   *  enabled servers - the selector below falls back to the full set. */
  toolsetIds: string[];
}

/** Cap on how many tasks a decomposition can yield, so a runaway brain reply can't
 *  spawn hundreds of sequential runs (and hundreds of dollars). */
const MAX_TASKS = 12;

const MARKER = /^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$/;

/** Strip inline markdown emphasis a decomposition often wraps a task title in. */
function stripEmphasis(s: string): string {
  return s.replace(/\*\*/g, "").replace(/^`+|`+$/g, "").trim();
}

/** Parse the brain's decomposition reply into task titles. Prefers explicit list
 *  markers (1. / 1) / - / * / •); if the reply has none, falls back to non-empty
 *  lines (a brain that answered as plain sentences). Caps the count. Pure. */
export function parseTaskList(text: string): string[] {
  const lines = text.split("\n");
  const marked: string[] = [];
  for (const line of lines) {
    const m = MARKER.exec(line);
    if (m) marked.push(stripEmphasis(m[1]));
  }
  const source = marked.length > 0 ? marked : lines.map((l) => stripEmphasis(l)).filter(Boolean);
  return source.filter(Boolean).slice(0, MAX_TASKS);
}

/** Build a fresh mission from an outcome and its task titles, with the first task
 *  active and the rest pending. Returns null if there are no titles (nothing to
 *  work), so the caller surfaces "I couldn't break that down" instead of an empty
 *  board. `toolsetIds` scopes the mission's tools (19.2); empty = all enabled. */
export function newMission(outcome: string, titles: string[], toolsetIds: string[] = []): Mission | null {
  const clean = titles.map((t) => t.trim()).filter(Boolean).slice(0, MAX_TASKS);
  if (clean.length === 0) return null;
  return {
    id: slugify(outcome) || "mission",
    outcome: outcome.trim(),
    tasks: clean.map((title, i) => ({ id: `t${i}`, title, status: i === 0 ? "active" : "pending" })),
    status: "active",
    toolsetIds: [...new Set(toolsetIds)],
  };
}

/** The task currently being worked, or null (mission finished / not started). */
export function activeTask(mission: Mission): MissionTask | null {
  return mission.tasks.find((t) => t.status === "active") ?? null;
}

/** Advance the board after the active task ran: mark it done (or failed, with an
 *  optional reason note, P1.4), then activate the next pending task. When none
 *  remain, the mission finishes - failed if any task failed, else done. Pure and
 *  immutable, so the reducer is unit-tested without dispatching a single real run. */
export function advanceMission(mission: Mission, ok: boolean, note?: string): Mission {
  const idx = mission.tasks.findIndex((t) => t.status === "active");
  if (idx < 0) return mission; // nothing active - already finished
  const tasks = mission.tasks.map((t) => ({ ...t }));
  tasks[idx].status = ok ? "done" : "failed";
  if (!ok && note?.trim()) tasks[idx].note = note.trim();
  const next = tasks.findIndex((t) => t.status === "pending");
  if (next >= 0) {
    tasks[next].status = "active";
    return { ...mission, tasks, status: "active" };
  }
  const status: MissionStatus = tasks.some((t) => t.status === "failed") ? "failed" : "done";
  return { ...mission, tasks, status };
}

/** Stop a mission in flight (B3.5): mark the active task failed and finish the
 *  mission `failed`, leaving pending tasks untouched. Pure. The board then shows a
 *  terminal state so the Clear button renders instead of the board staying "active"
 *  forever. A no-op if nothing is active (already finished). */
export function stopMission(mission: Mission): Mission {
  if (!mission.tasks.some((t) => t.status === "active")) return mission;
  const tasks = mission.tasks.map((t) => (t.status === "active" ? { ...t, status: "failed" as TaskStatus } : t));
  return { ...mission, tasks, status: "failed" };
}

export interface MissionProgress {
  done: number;
  failed: number;
  total: number;
}

/** Count the board for the compact "2/5" readout both faces show. */
export function missionProgress(mission: Mission): MissionProgress {
  let done = 0;
  let failed = 0;
  for (const t of mission.tasks) {
    if (t.status === "done") done++;
    else if (t.status === "failed") failed++;
  }
  return { done, failed, total: mission.tasks.length };
}

/** The MCP servers relevant to a mission (19.2 composable toolsets): only the ones
 *  the mission named, so a session's tool surface stays lean (voice latency likes a
 *  small surface anyway). An empty toolset means "no restriction" - every enabled
 *  server, the pre-mission behaviour. Pure. */
export function relevantServers(entries: McpServerEntry[], toolsetIds: string[]): McpServerEntry[] {
  if (toolsetIds.length === 0) return entries;
  const want = new Set(toolsetIds);
  return entries.filter((e) => want.has(e.id));
}

// --- Verify → retry (improvement-5 P1.4) -----------------------------------
// After a task runs, an optional cheap verification turn grades PASS/FAIL; a FAIL
// gets one retry with the failure reason as context. These are the pure pieces
// (the verdict parser + the two prompt builders); the orchestration lives in
// mission-runner.ts, so the risky parsing is unit-tested without a brain.

export interface Verdict {
  pass: boolean;
  /** One short reason, for the retry prompt and the task note. */
  reason: string;
}

/** The first non-empty line of `text`, capped, as a one-sentence reason. */
function firstLine(text: string, cap = 200): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/** Parse a verification turn's reply into PASS/FAIL + a reason (sibling of
 *  parseTaskList). Conservative: PASS only on an explicit PASS with no FAIL, so an
 *  ambiguous or errored verdict fails the task (and triggers the retry) rather than
 *  marking murky work done. Pure. */
export function parseVerdict(text: string): Verdict {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[^A-Za-z]+/, "");
    if (/^pass\b/i.test(line)) return { pass: true, reason: firstLine(line) };
    if (/^fail\b/i.test(line)) return { pass: false, reason: firstLine(line) || "The task did not pass verification." };
  }
  const up = text.toUpperCase();
  const pass = up.includes("PASS") && !up.includes("FAIL");
  return { pass, reason: firstLine(text) || "The task did not pass verification." };
}

/** The verification-turn prompt: ask the brain to grade whether the task actually
 *  succeeded toward the outcome, PASS/FAIL + one reason. Pure. */
export function verifyPrompt(outcome: string, task: string): string {
  return (
    `You just attempted this task, part of the goal "${outcome.trim()}":\n\n${task.trim()}\n\n` +
    `Check whether it actually succeeded - use tools to look if you can. Reply with the single word ` +
    `PASS or FAIL on the first line, then one short sentence explaining why.`
  );
}

/** The retry prompt: re-run the task with the prior failure reason as context. Pure. */
export function retryPrompt(task: string, reason: string): string {
  const why = reason.trim();
  return `${task.trim()}\n\nA previous attempt did not succeed${why ? `: ${why}` : ""}. Try again, addressing that.`;
}

const STATUSES: TaskStatus[] = ["pending", "active", "done", "failed"];
const M_STATUSES: MissionStatus[] = ["active", "done", "failed"];

/** Coerce a raw value (the persisted june-mission.json, or a mission://updated
 *  event payload) into a valid Mission, or null if it isn't one. Both faces read
 *  through this so a malformed/absent file never crashes the board. */
export function coerceMission(raw: unknown): Mission | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const outcome = typeof r.outcome === "string" ? r.outcome : "";
  if (!Array.isArray(r.tasks)) return null;
  const tasks: MissionTask[] = [];
  for (const t of r.tasks) {
    if (typeof t !== "object" || t === null) continue;
    const tr = t as Record<string, unknown>;
    const title = typeof tr.title === "string" ? tr.title.trim() : "";
    if (!title) continue;
    const note = typeof tr.note === "string" && tr.note.trim() ? tr.note.trim() : undefined;
    tasks.push({
      id: typeof tr.id === "string" && tr.id ? tr.id : `t${tasks.length}`,
      title,
      status: STATUSES.includes(tr.status as TaskStatus) ? (tr.status as TaskStatus) : "pending",
      ...(note ? { note } : {}),
    });
  }
  if (tasks.length === 0) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : "mission",
    outcome,
    tasks,
    status: M_STATUSES.includes(r.status as MissionStatus) ? (r.status as MissionStatus) : "active",
    toolsetIds: Array.isArray(r.toolsetIds) ? r.toolsetIds.filter((x): x is string => typeof x === "string") : [],
  };
}
