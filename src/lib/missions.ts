// Missions & platform completion (improvement-4 Phase 19.1/19.2). A user states an
// OUTCOME; June decomposes it into a verifiable task list, the user confirms the
// plan (improvement-5 P2 5.3), and a Rust-side runner works the tasks one per
// session (P2 5.2), updating a task board both faces can watch.
//
// This module is the pure, tauri-free, SDK-free view-side core: the shapes, the
// decomposition prompt + parsers (task list, TOOLS: line), and the board coercion
// the two faces render through. The board reducer, the verify -> retry loop, and
// the orchestration live in Rust (src-tauri/src/missions.rs) now, unit-tested
// there; what stays here is exactly what the webview needs.

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
 *  spawn hundreds of sequential runs (and hundreds of dollars). Mirrored by the
 *  Rust runner's MAX_TASKS. */
const MAX_TASKS = 12;

const MARKER = /^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$/;
const TOOLS_LINE = /^\s*tools\s*:\s*(.*)$/i;

/** Strip inline markdown emphasis a decomposition often wraps a task title in. */
function stripEmphasis(s: string): string {
  return s.replace(/\*\*/g, "").replace(/^`+|`+$/g, "").trim();
}

/** Parse the brain's decomposition reply into task titles. Prefers explicit list
 *  markers (1. / 1) / - / * / •); if the reply has none, falls back to non-empty
 *  lines (a brain that answered as plain sentences), skipping a TOOLS: line (5.4).
 *  Caps the count. Pure. */
export function parseTaskList(text: string): string[] {
  const lines = text.split("\n");
  const marked: string[] = [];
  for (const line of lines) {
    const m = MARKER.exec(line);
    if (m) marked.push(stripEmphasis(m[1]));
  }
  const source =
    marked.length > 0
      ? marked
      : lines.filter((l) => !TOOLS_LINE.test(l)).map((l) => stripEmphasis(l)).filter(Boolean);
  return source.filter(Boolean).slice(0, MAX_TASKS);
}

/** The decomposition prompt (5.3 plan -> confirm). Asks for the numbered task
 *  list, and - when the user has generic capability servers enabled - for a
 *  leading TOOLS: line naming the relevant ones (19.2/5.4 composable toolsets),
 *  so the mission's tool surface can stay lean. Pure. */
export function decomposePrompt(outcome: string, serverIds: string[] = []): string {
  const tools =
    serverIds.length > 0
      ? `Start with one line "TOOLS:" followed by the comma-separated ids of the capability servers this outcome needs, chosen only from: ${serverIds.join(", ")}. Write "TOOLS: all" if it needs all of them. Then write the checklist.\n`
      : "";
  return (
    "Break this outcome into a short, ordered checklist of concrete tasks, each doable on its own. " +
    "Reply with ONLY a numbered list - one task per line, no preamble, no closing remarks.\n" +
    tools +
    `\nOutcome: ${outcome}`
  );
}

/** Parse the TOOLS: line out of a decomposition reply (5.4): the server ids the
 *  brain says this mission needs, kept only if the user actually has them.
 *  "all" / absent / garbled all read as [] = no restriction - the safe default is
 *  the full tool surface, never a broken mission. Pure. */
export function parseToolsets(text: string, knownIds: string[]): string[] {
  for (const line of text.split("\n")) {
    const m = TOOLS_LINE.exec(line);
    if (!m) continue;
    const raw = m[1].trim().toLowerCase();
    if (!raw || raw === "all" || raw === "none") return [];
    const known = new Set(knownIds);
    const want = raw.split(/[,\s]+/).filter((id) => known.has(id));
    return [...new Set(want)];
  }
  return [];
}

/** The task currently being worked, or null (mission finished / not started). */
export function activeTask(mission: Mission): MissionTask | null {
  return mission.tasks.find((t) => t.status === "active") ?? null;
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
