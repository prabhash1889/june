import { useCallback, useEffect, useState } from "react";

import { type RunRecord } from "../lib/runs.ts";
import { readRuns } from "../lib/session.ts";

// The Runs tab (improvement-5 P1.3). A reviewable history of every unattended run
// - scheduled runs, file triggers, and watch loops - with June's reply and the
// gated actions each run was blocked from doing. Both deep dives flagged this as
// the biggest trust-surface gap: an autonomous run's result (and what it wanted to
// do but couldn't) used to vanish into a single transient notification. Follows
// MissionBoard's shape - a read-only view over Rust-owned state.

/** "2026-07-20T09:00:05" -> "Jul 20, 09:00". Falls back to the raw value. */
function when(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function RunsPanel() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRuns(await readRuns());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="runs">
      <div className="runs-head">
        <p className="settings-hint">
          Every unattended run - scheduled runs, file triggers, and watch loops - with June's reply and any action it was
          blocked from taking. Newest first.
        </p>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="empty">{loading ? "Loading runs…" : "No unattended runs yet. Add a schedule or watch loop in Settings."}</p>
      ) : (
        <ul className="runs-list">
          {runs.map((r) => (
            <li key={r.id} className={`run-item ${r.isError ? "run-error" : ""}`}>
              <div className="run-item-head">
                <span className="run-source">{r.source}</span>
                <span className="run-time">{when(r.started)}</span>
                {r.isError && <span className="run-badge bad">error</span>}
                {r.blocked.length > 0 && (
                  <span className="run-badge warn">
                    {r.blocked.length} blocked
                  </span>
                )}
              </div>
              {r.reply && <p className="run-reply">{r.reply}</p>}
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
