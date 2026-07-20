// Run history ledger (improvement-5 P1.3). Every unattended run (schedule, file
// trigger, watch loop) is appended to `<app_data_dir>/june-runs.jsonl` by Rust
// (agent_runner.rs::append_run); the Runs tab reads it back through `read_runs`.
// This module is the tauri-free typed view + defensive coercion, so a malformed
// or partial ledger line never crashes the panel - the same discipline as
// schedules.ts / missions.ts. The biggest trust-surface gap both deep dives
// flagged: an unattended run's result (and what it was blocked from doing) was
// invisible; now it is reviewable.

export interface RunRecord {
  id: number;
  /** Origin, e.g. "schedule: Morning briefing" / "trigger: Errors" / "watch: Build". */
  source: string;
  /** The task prompt (redacted to a length marker under on-device privacy modes). */
  prompt: string;
  /** ISO-ish local timestamps stamped by Rust ("YYYY-MM-DDTHH:MM:SS"). */
  started: string;
  ended: string;
  /** June's reply (redacted under on-device privacy modes). */
  reply: string;
  isError: boolean;
  /** Human-readable summaries of gated actions the run was blocked from doing. */
  blocked: string[];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerce one raw ledger line into a RunRecord, or null if it isn't one. */
export function coerceRun(raw: unknown): RunRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // A record with neither a source nor a reply is noise, not a run.
  if (typeof r.source !== "string" && typeof r.reply !== "string") return null;
  return {
    id: typeof r.id === "number" && Number.isFinite(r.id) ? r.id : 0,
    source: str(r.source, "unattended"),
    prompt: str(r.prompt),
    started: str(r.started),
    ended: str(r.ended),
    reply: str(r.reply),
    isError: r.isError === true,
    blocked: Array.isArray(r.blocked) ? r.blocked.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Coerce the raw `read_runs` array (already newest-first from Rust) into clean
 *  records, dropping any that can't be salvaged. Pure. */
export function coerceRuns(raw: unknown): RunRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: RunRecord[] = [];
  for (const item of raw) {
    const rec = coerceRun(item);
    if (rec) out.push(rec);
  }
  return out;
}
