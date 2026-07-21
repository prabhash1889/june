import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { type RunRecord } from "../lib/runs.ts";
import { readRuns } from "../lib/session.ts";

// The Runs tab (improvement-5 P1.3, extended in improvement-6 2.4). A reviewable
// history of every unattended run - scheduled runs, file triggers, watch loops -
// plus mission tasks (2.3), with June's reply, the prompt it ran, and the gated
// actions each run was blocked from doing. Both deep dives flagged this as the
// biggest trust-surface gap: an autonomous run's result (and what it wanted to do
// but couldn't) used to vanish into a single transient notification. 2.4 makes it
// live (auto-refresh on `runs://updated`), shows the run's prompt (expandable), and
// uses relative times.

/** "2026-07-20T09:00:05" -> "Jul 20, 09:00" for the hover title. Raw fallback. */
function absolute(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A compact "just now / 5m ago / 3h ago / 2d ago" relative stamp (2.4). Falls back
 *  to the raw value for an unparseable timestamp. */
function relative(ts: string): string {
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

export function RunsPanel() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Silent refresh for event-driven reloads so a live `runs://updated` doesn't
  // flash the "Loading…" state; the manual Refresh button shows it.
  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setRuns(await readRuns());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    // Auto-refresh when a run lands (2.4): the ledger was manual-refresh only, so a
    // scheduled run's result appeared only if the user happened to hit Refresh.
    const unlisten = listen("runs://updated", () => void refresh(true));
    return () => void unlisten.then((f) => f());
  }, [refresh]);

  return (
    <div className="runs">
      <div className="runs-head">
        <p className="settings-hint">
          Every unattended run - scheduled runs, file triggers, watch loops - and mission tasks, with June's reply, the
          prompt it ran, and any action it was blocked from taking. Newest first, updated live.
        </p>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="empty">{loading ? "Loading runs…" : "No runs yet. Add a schedule or watch loop in Settings, or start a mission."}</p>
      ) : (
        <ul className="runs-list">
          {runs.map((r) => (
            <li key={r.id} className={`run-item ${r.isError ? "run-error" : ""}`}>
              <div className="run-item-head">
                <span className="run-source">{r.source}</span>
                <span className="run-time" title={absolute(r.started)}>
                  {relative(r.started)}
                </span>
                {r.isError && <span className="run-badge bad">error</span>}
                {r.blocked.length > 0 && <span className="run-badge warn">{r.blocked.length} blocked</span>}
              </div>
              {r.reply && <p className="run-reply">{r.reply}</p>}
              {r.prompt && (
                <details className="run-prompt">
                  <summary>Prompt</summary>
                  <p>{r.prompt}</p>
                </details>
              )}
              {r.blocked.length > 0 && (
                <ul className="run-blocked">
                  {r.blocked.map((b, i) => (
                    <li key={i}>Blocked: {b}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
