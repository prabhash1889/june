import { useState, useSyncExternalStore } from "react";

import { activeTask, type Mission, missionProgress } from "../lib/missions.ts";
import { runnerState, startMission, stopRunningMission, subscribeRunner } from "../lib/mission-runner.ts";
import { useMission, writeMission } from "../lib/session.ts";

// Missions (improvement-4 Phase 19.1). A user states an OUTCOME; June decomposes it
// into a task list and works the tasks one per session, updating a board this window
// and the widget both watch (via the shared `mission://updated` broadcast). The pure
// board logic is missions.ts; the orchestration is the module-level runner in
// mission-runner.ts (improvement-5 P0.3: it must outlive this tab-mounted
// component); this is just the surface.

export function MissionBoard() {
  const mission = useMission();
  const [outcome, setOutcome] = useState("");
  // Per-task verify → retry loop (improvement-5 P1.4), on by default.
  const [verify, setVerify] = useState(true);
  const { running, error } = useSyncExternalStore(subscribeRunner, runnerState);

  const start = () => {
    const o = outcome.trim();
    if (!o || running) return;
    void startMission(o, verify).then(() => {
      if (!runnerState().error) setOutcome("");
    });
  };

  return (
    <div className="missions">
      <div className="mission-compose">
        <label htmlFor="mission-outcome">State an outcome and June will plan it into tasks and work them one by one.</label>
        <textarea
          id="mission-outcome"
          value={outcome}
          placeholder="e.g. Prepare a release: update the changelog, run the tests, and draft the announcement."
          rows={3}
          disabled={running}
          onChange={(e) => setOutcome(e.target.value)}
        />
        <div className="row">
          <button className="primary" disabled={!outcome.trim() || running} onClick={start}>
            {running ? "Working the mission…" : "Start mission"}
          </button>
          {running && (
            <button className="danger" onClick={stopRunningMission}>
              Stop
            </button>
          )}
          <label className="wake-toggle" title="After each task, June checks it succeeded and retries once if not.">
            <input type="checkbox" checked={verify} disabled={running} onChange={(e) => setVerify(e.target.checked)} />
            <span>Verify each task</span>
          </label>
        </div>
        {error && <p className="err">{error}</p>}
      </div>

      {mission ? <Board mission={mission} running={running} /> : <p className="empty">No mission yet.</p>}
    </div>
  );
}

function Board({ mission, running }: { mission: Mission; running: boolean }) {
  const { done, failed, total } = missionProgress(mission);
  const current = activeTask(mission);
  const [clearFailed, setClearFailed] = useState(false);
  return (
    <div className="mission-board">
      <div className="mission-head">
        <span className={`mission-badge ${mission.status}`}>{mission.status}</span>
        <span className="mission-outcome">{mission.outcome}</span>
        <span className="mission-count">
          {done + failed}/{total}
        </span>
      </div>
      <ul className="mission-tasks">
        {mission.tasks.map((t) => (
          <li key={t.id} className={`mission-task ${t.status}`}>
            <span className="mission-task-mark" aria-hidden="true">
              {t.status === "done" ? "✓" : t.status === "failed" ? "✕" : t.status === "active" ? "▸" : "○"}
            </span>
            <span className="mission-task-title">
              {t.title}
              {t.note && <span className="mission-task-note"> - {t.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      {running && current && <p className="status">Working: {current.title}</p>}
      {!running && mission.status !== "active" && (
        <button
          className="mission-clear"
          onClick={() => void writeMission(null).then(() => setClearFailed(false), () => setClearFailed(true))}
        >
          Clear mission
        </button>
      )}
      {clearFailed && <p className="err">Couldn't clear the board. Try again.</p>}
    </div>
  );
}
