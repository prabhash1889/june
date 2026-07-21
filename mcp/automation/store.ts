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
