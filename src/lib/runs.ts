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

/** The most recent run matching an automation card's ledger source (6.2). A card's
 *  source is "schedule: <label>" / "trigger: <label>" / "watch: <label>"; a
 *  "Run now" fire appends a suffix ("schedule: X (run now)"), so match the exact
 *  source or that source followed by a space. `runs` is newest-first, so the first
 *  match is the latest. Pure. */
export function lastRunFor(runs: RunRecord[], source: string): RunRecord | null {
  for (const r of runs) {
    if (r.source === source || r.source.startsWith(`${source} `)) return r;
  }
  return null;
}

/** Compact "just now / 5m ago / 3h ago / 2d ago" relative stamp (2.4 / 6.2), shared
 *  by the Runs panel and the automation cards. Falls back to the raw value for an
 *  unparseable timestamp. */
export function relativeTime(ts: string): string {
  const d = new Date(ts).getTime();
  if (Number.isNaN(d)) return ts;
  const secs = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
