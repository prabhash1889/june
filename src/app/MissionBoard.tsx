import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { activeTask, advanceMission, type Mission, missionProgress, newMission, parseTaskList } from "../lib/missions.ts";
import { newConversation, useMission, writeMission } from "../lib/session.ts";

// Missions (improvement-4 Phase 19.1). A user states an OUTCOME; June decomposes it
// into a task list and works the tasks one per session, updating a board this window
// and the widget both watch (via the shared `mission://updated` broadcast). The pure
// board logic is missions.ts; this is the orchestration + surface.
//
// Every task runs through the same execution-layer gate as an interactive turn, so a
// mission's actions are approved and audited exactly like any other (the reviewable
// audit trail the exit criterion names, 10.7) - a mission is not a bypass.

// Turn-number space for mission runs. Above the widget's small per-webview counter
// and below the unattended space (1<<40), so a mission dispatch can never collide
// with an interactive or scheduled turn in the shared Rust turns map.
let missionTurn = 1_000_000;

const decomposePrompt = (outcome: string): string =>
  "Break this outcome into a short, ordered checklist of concrete tasks, each doable on its own. " +
  "Reply with ONLY a numbered list - one task per line, no preamble, no closing remarks.\n\n" +
  `Outcome: ${outcome}`;

/** Run a mission end to end: decompose the outcome into tasks, then dispatch each as
 *  its own fresh session (Phase 19.1 "sequential sessions per task"), advancing the
 *  shared board after each. Each `run_agent` streams into the conversation view and
 *  goes through the normal gate + audit log. Stops early if `isCancelled` flips. */
async function runMission(outcome: string, isCancelled: () => boolean): Promise<void> {
  const listReply = await invoke<string>("run_agent", { transcript: decomposePrompt(outcome), turn: missionTurn++ });
  let mission = newMission(outcome, parseTaskList(listReply));
  if (!mission) throw new Error("I couldn't break that outcome into tasks. Try rephrasing it.");
  await writeMission(mission);

  // Dispatch in list order; advanceMission walks the active pointer to match.
  for (let i = 0; i < mission.tasks.length; i++) {
    if (isCancelled()) return;
    await newConversation(); // a fresh session per task, so tasks don't bleed context
    let ok = true;
    try {
      await invoke<string>("run_agent", { transcript: mission.tasks[i].title, turn: missionTurn++ });
    } catch {
      ok = false; // a failed task doesn't abort the mission - work the rest, finish "failed"
    }
    mission = advanceMission(mission, ok);
    await writeMission(mission);
  }
}

export function MissionBoard() {
  const mission = useMission();
  const [outcome, setOutcome] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const start = async () => {
    const o = outcome.trim();
    if (!o || running) return;
    setRunning(true);
    setError(null);
    cancelRef.current = false;
    try {
      await runMission(o, () => cancelRef.current);
      setOutcome("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
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
          <button className="primary" disabled={!outcome.trim() || running} onClick={() => void start()}>
            {running ? "Working the mission…" : "Start mission"}
          </button>
          {running && (
            <button className="danger" onClick={() => (cancelRef.current = true)}>
              Stop
            </button>
          )}
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
            <span className="mission-task-title">{t.title}</span>
          </li>
        ))}
      </ul>
      {running && current && <p className="status">Working: {current.title}</p>}
      {!running && mission.status !== "active" && (
        <button className="mission-clear" onClick={() => void writeMission(null)}>
          Clear mission
        </button>
      )}
    </div>
  );
}
