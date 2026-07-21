// Pure settings-merge helpers for the automation capability (improvement-5 P1.5).
// Kept side-effect-free and separate from server.ts so the merge/validate/summary
// logic is unit-tested without a real settings file (mirrors mcp/memory/store.ts).
//
// The one source of truth for a schedule/watch shape and its validation lives in
// src/lib/schedules.ts; this module reuses that coercion so a voice-created
// automation is validated exactly like a settings-panel one - no second schema.

import {
  coerceSchedules,
  coerceWatches,
  type Schedule,
  type WatchLoop,
} from "../../src/lib/schedules.ts";

/** The raw settings bag (settings.json), the same shape the frontend merges over. */
export type SettingsBag = Record<string, unknown>;

/** Validate one raw schedule input into a clean Schedule, or null if it can't be a
 *  valid schedule (a `daily` with no time, an `every` with no interval). Reuses the
 *  shared coercion so voice and settings-panel schedules are validated identically. */
export function validateSchedule(input: unknown): Schedule | null {
  return coerceSchedules([input])[0] ?? null;
}

/** Validate one raw watch-loop input into a clean WatchLoop, or null if it has no
 *  usable interval. */
export function validateWatch(input: unknown): WatchLoop | null {
  return coerceWatches([input])[0] ?? null;
}

/** Append a validated schedule to the bag's schedule list, re-coercing so ids stay
 *  unique (a colliding label gets a -2 suffix). Pure: returns a new bag, preserving
 *  every other settings key. */
export function withSchedule(bag: SettingsBag, schedule: Schedule): SettingsBag {
  const existing = Array.isArray(bag.schedules) ? bag.schedules : [];
  return { ...bag, schedules: coerceSchedules([...existing, schedule]) };
}

/** Append a validated watch loop to the bag's watch list, re-coercing for unique
 *  ids. Pure. */
export function withWatch(bag: SettingsBag, watch: WatchLoop): SettingsBag {
  const existing = Array.isArray(bag.watches) ? bag.watches : [];
  return { ...bag, watches: coerceWatches([...existing, watch]) };
}

/** A voice-started mission request (improvement-6 4.10). The brain decomposes the
 *  outcome into confirmed task titles; the scheduler tick picks this up and starts
 *  it through the same path as the start_mission command. Written to settings.json
 *  so the always-running Rust scheduler (not a webview) consumes it. */
export interface PendingMission {
  outcome: string;
  tasks: string[];
  /** Which enabled MCP servers the mission may use (5.4); empty = the defaults. */
  toolsetIds: string[];
  verify: boolean;
}

/** Coerce a raw start_mission input into a clean PendingMission, or null if it has
 *  no outcome or no non-empty task (a mission with nothing to do is rejected up
 *  front rather than written and later dropped Rust-side). Pure. */
export function coercePendingMission(input: unknown): PendingMission | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  const outcome = typeof r.outcome === "string" ? r.outcome.trim() : "";
  if (!outcome) return null;
  const tasks = (Array.isArray(r.tasks) ? r.tasks : [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tasks.length === 0) return null;
  const toolsetIds = (Array.isArray(r.toolsetIds) ? r.toolsetIds : []).filter(
    (t): t is string => typeof t === "string",
  );
  return { outcome, tasks, toolsetIds, verify: r.verify !== false };
}

/** Append a validated mission request to the bag's pending-mission queue. Pure:
 *  returns a new bag preserving every other settings key. The scheduler pops the
 *  head of this list and clears it as it starts each mission. */
export function withPendingMission(bag: SettingsBag, mission: PendingMission): SettingsBag {
  const existing = Array.isArray(bag.pendingMissions) ? bag.pendingMissions : [];
  return { ...bag, pendingMissions: [...existing, mission] };
}

/** Which automation list an entry lives in (improvement-6 4.2). */
export type AutomationKind = "schedule" | "watch" | "trigger";

/** What a management op (enable/disable/remove) matched, for the spoken reply. Null
 *  from the helpers means nothing matched the given id/label. */
export interface ManageResult {
  kind: AutomationKind;
  id: string;
  label: string;
}

/** The three managed lists and their settings keys, scanned in this order (4.2). */
const LISTS: readonly { kind: AutomationKind; key: string }[] = [
  { kind: "schedule", key: "schedules" },
  { kind: "watch", key: "watches" },
  { kind: "trigger", key: "triggers" },
];

/** Match an automation by exact id OR case-insensitive label (4.2), so a voice
 *  "stop the build watch" resolves the entry the same way the user named it. */
function matches(entry: Record<string, unknown>, idOrLabel: string): boolean {
  const needle = idOrLabel.trim().toLowerCase();
  if (!needle) return false;
  const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
  const label = typeof entry.label === "string" ? entry.label.trim().toLowerCase() : "";
  return id === needle || label === needle;
}

/** Find the first automation across all three lists matching `idOrLabel`. Returns
 *  its list key + index (into the ORIGINAL array, so a caller mutates only that one
 *  entry and preserves every other verbatim), or null. */
function findMatch(
  bag: SettingsBag,
  idOrLabel: string,
): { kind: AutomationKind; key: string; idx: number; list: unknown[]; entry: Record<string, unknown> } | null {
  for (const { kind, key } of LISTS) {
    const list = bag[key];
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex((e) => typeof e === "object" && e !== null && matches(e as Record<string, unknown>, idOrLabel));
    if (idx >= 0) return { kind, key, idx, list, entry: list[idx] as Record<string, unknown> };
  }
  return null;
}

function resultOf(m: { kind: AutomationKind; entry: Record<string, unknown> }): ManageResult {
  return {
    kind: m.kind,
    id: typeof m.entry.id === "string" ? m.entry.id : "",
    label: typeof m.entry.label === "string" ? m.entry.label : "",
  };
}

/** Enable or disable one automation by id/label (4.2). Pure: returns a new bag with
 *  only the matched entry's `enabled` flipped (every other entry, and every other
 *  settings key, preserved verbatim), plus what matched - or the bag unchanged and a
 *  null result if nothing matched. */
export function setAutomationEnabled(
  bag: SettingsBag,
  idOrLabel: string,
  enabled: boolean,
): { bag: SettingsBag; result: ManageResult | null } {
  const m = findMatch(bag, idOrLabel);
  if (!m) return { bag, result: null };
  const next = m.list.map((e, i) => (i === m.idx ? { ...(e as Record<string, unknown>), enabled } : e));
  return { bag: { ...bag, [m.key]: next }, result: resultOf(m) };
}

/** Remove one automation by id/label (4.2). Pure: returns a new bag with the matched
 *  entry dropped (everything else preserved) plus what matched - or the bag unchanged
 *  and a null result if nothing matched. */
export function removeAutomation(bag: SettingsBag, idOrLabel: string): { bag: SettingsBag; result: ManageResult | null } {
  const m = findMatch(bag, idOrLabel);
  if (!m) return { bag, result: null };
  const next = m.list.filter((_, i) => i !== m.idx);
  return { bag: { ...bag, [m.key]: next }, result: resultOf(m) };
}

/** A one-paragraph, spoken-style summary of the current automations for
 *  list_automations. Reads the bag through the shared coercers so it reflects
 *  exactly what the scheduler will act on. Pure. */
export function summarizeAutomations(bag: SettingsBag): string {
  const schedules = coerceSchedules(bag.schedules);
  const watches = coerceWatches(bag.watches);
  const triggers = Array.isArray(bag.triggers) ? bag.triggers.length : 0;

  const parts: string[] = [];
  if (schedules.length === 0 && watches.length === 0 && triggers === 0) {
    return "There are no automations set up yet.";
  }
  if (schedules.length > 0) {
    parts.push(
      `Schedules: ${schedules
        .map((s) => `${s.label} (${describeSchedule(s)}${s.enabled ? "" : ", off"})`)
        .join("; ")}.`,
    );
  }
  if (watches.length > 0) {
    parts.push(
      `Watch loops: ${watches
        .map((w) => `${w.label} (every ${w.everyMinutes} min${w.untilCondition ? ` until ${w.untilCondition}` : ""}${w.enabled ? "" : ", off"})`)
        .join("; ")}.`,
    );
  }
  if (triggers > 0) parts.push(`${triggers} file trigger${triggers === 1 ? "" : "s"}.`);
  return parts.join(" ");
}

/** Human-readable recurrence for one schedule. */
function describeSchedule(s: Schedule): string {
  if (s.kind === "once") return `once at ${s.at}`;
  if (s.kind === "every") return `every ${s.everyMinutes} min`;
  const days = s.days.length === 0 ? "every day" : `on ${s.days.length} day${s.days.length === 1 ? "" : "s"}`;
  return `daily at ${s.time} ${days}`;
}
