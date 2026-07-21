import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { activeTask, decomposePrompt, type Mission, missionProgress, parseTaskList, parseToolsets } from "../lib/missions.ts";
import { allocTurn, newConversation, setMissionPaused, useMission, useMissionPaused, writeMission } from "../lib/session.ts";
import { DEFAULT_SETTINGS, loadSettings } from "../lib/settings.ts";
import { runAgent } from "../lib/stt.ts";

// Missions (improvement-4 Phase 19.1, improvement-5 P2). A user states an
// OUTCOME; June decomposes it into a task list shown here for confirmation or
// editing (5.3), then a Rust-side runner (src-tauri/src/missions.rs, 5.2) works
// the tasks one per session - surviving tab switches, window closes, and app
// restarts - updating a board this window and the widget both watch (via the
// shared `mission://updated` broadcast). This component is a surface: it plans
// via one interactive turn and renders Rust-owned state.

/** A decomposed-but-unconfirmed plan: tasks as editable lines (5.3). `serverIds`
 *  is every enabled capability server, so the confirm view can offer the toolset
 *  as editable checkboxes (5.5) rather than a fixed guess. */
interface Plan {
  outcome: string;
  tasks: string;
  toolsetIds: string[];
  serverIds: string[];
}

export function MissionBoard() {
  const mission = useMission();
  const paused = useMissionPaused();
  const [outcome, setOutcome] = useState("");
  // Per-task verify → retry loop (improvement-5 P1.4), on by default.
  const [verify, setVerify] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The Rust runner resumes an active board on startup, so "board active" IS
  // "runner alive" - no separate running flag to drift out of sync.
  const running = mission?.status === "active";

  const planMission = async () => {
    const o = outcome.trim();
    if (!o || planning || running) return;
    setPlanning(true);
    setError(null);
    try {
      const s = await loadSettings().catch(() => DEFAULT_SETTINGS);
      const serverIds = s.mcpServers.filter((e) => e.enabled).map((e) => e.id);
      await newConversation(); // decompose in a fresh conversation (B3.6)
      const reply = await runAgent(decomposePrompt(o, serverIds), allocTurn());
      if (reply.isError) throw new Error(reply.text || "Planning failed. Try again.");
      const tasks = parseTaskList(reply.text);
      if (tasks.length === 0) throw new Error("I couldn't break that outcome into tasks. Try rephrasing it.");
      setPlan({ outcome: o, tasks: tasks.join("\n"), toolsetIds: parseToolsets(reply.text, serverIds), serverIds });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  const confirm = async () => {
    if (!plan) return;
    const tasks = plan.tasks.split("\n").map((t) => t.trim()).filter(Boolean);
    if (tasks.length === 0) {
      setError("The plan has no tasks left. Add at least one line.");
      return;
    }
    try {
      await invoke("start_mission", { outcome: plan.outcome, tasks, toolsetIds: plan.toolsetIds, verify });
      setPlan(null);
      setOutcome("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    void invoke("stop_mission").catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="missions">
      <div className="mission-compose">
        <label htmlFor="mission-outcome">State an outcome and June will plan it into tasks for you to confirm.</label>
        <textarea
          id="mission-outcome"
          value={outcome}
          placeholder="e.g. Prepare a release: update the changelog, run the tests, and draft the announcement."
          rows={3}
          disabled={planning || running || plan !== null}
          onChange={(e) => setOutcome(e.target.value)}
        />
        <div className="row">
          <button
            className="primary"
            disabled={!outcome.trim() || planning || running || plan !== null}
            onClick={() => void planMission()}
          >
            {planning ? "Planning…" : running ? "Working the mission…" : "Plan mission"}
          </button>
          {running && (
            <>
              <button
                onClick={() => void setMissionPaused(!paused).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
                title={paused ? "Resume the mission" : "Hold the mission after the current task"}
              >
                {paused ? "Resume" : "Pause"}
              </button>
              <button className="danger" onClick={stop}>
                Stop
              </button>
            </>
          )}
          <label className="wake-toggle" title="After each task, June checks it succeeded and retries once if not.">
            <input
              type="checkbox"
              checked={verify}
              disabled={running || plan !== null}
              onChange={(e) => setVerify(e.target.checked)}
            />
            <span>Verify each task</span>
          </label>
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>

      {plan && (
        <div className="mission-plan">
          <p className="settings-hint">June plans these tasks - edit the lines, then start the mission.</p>
          <textarea
            aria-label="Planned tasks, one per line"
            value={plan.tasks}
            rows={Math.min(10, Math.max(3, plan.tasks.split("\n").length + 1))}
            onChange={(e) => setPlan({ ...plan, tasks: e.target.value })}
          />
          {plan.serverIds.length > 0 && (
            <div className="mission-toolset">
              <p className="settings-hint">
                Tools for this mission - June guessed these; adjust if it's wrong. None checked = all enabled tools.
              </p>
              <div className="row">
                {plan.serverIds.map((id) => (
                  <label key={id} className="wake-toggle">
                    <input
                      type="checkbox"
                      checked={plan.toolsetIds.includes(id)}
                      onChange={(e) =>
                        setPlan({
                          ...plan,
                          toolsetIds: e.target.checked
                            ? [...plan.toolsetIds, id]
                            : plan.toolsetIds.filter((x) => x !== id),
                        })
                      }
                    />
                    <span>{id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="row">
            <button className="primary" onClick={() => void confirm()}>
              Start mission
            </button>
            <button
              onClick={() => {
                setPlan(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mission ? <Board mission={mission} running={running} paused={paused} /> : !plan && <p className="empty">No mission yet.</p>}
    </div>
  );
}

function Board({ mission, running, paused = false }: { mission: Mission; running: boolean; paused?: boolean }) {
  const { done, failed, total } = missionProgress(mission);
  const current = activeTask(mission);
  const [clearFailed, setClearFailed] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Re-run just the failed tasks (5.2): a failed board holds the titles and the
  // verify notes, so the user needn't re-type anything. Each failed title carries
  // its prior failure note as context (not an instruction), and the retry reuses
  // this mission's toolset. Verify is on so the retried tasks are re-checked.
  const retryFailed = () => {
    const tasks = mission.tasks
      .filter((t) => t.status === "failed")
      .map((t) => (t.note ? `${t.title}\n\n(A previous attempt failed: ${t.note})` : t.title));
    if (tasks.length === 0) return;
    setRetryError(null);
    void invoke("start_mission", {
      outcome: mission.outcome,
      tasks,
      toolsetIds: mission.toolsetIds,
      verify: true,
    }).catch((e) => setRetryError(e instanceof Error ? e.message : String(e)));
  };
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
      {running && current && (
        <p className="status" role="status">
          {paused ? `Paused - will resume after: ${current.title}` : `Working: ${current.title}`}
        </p>
      )}
      {!running && (
        <div className="row">
          {failed > 0 && (
            <button className="primary" onClick={retryFailed}>
              Retry failed {failed === 1 ? "task" : "tasks"}
            </button>
          )}
          <button
            className="mission-clear"
            onClick={() => void writeMission(null).then(() => setClearFailed(false), () => setClearFailed(true))}
          >
            Clear mission
          </button>
        </div>
      )}
      {retryError && (
        <p className="err" role="alert">
          {retryError}
        </p>
      )}
      {clearFailed && (
        <p className="err" role="alert">
          Couldn't clear the board. Try again.
        </p>
      )}
    </div>
  );
}
