import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { msg } from "./common.ts";
import { lastRunFor, relativeTime, type RunRecord } from "../../lib/runs.ts";
import {
  describeNext,
  type FileTrigger,
  type Schedule,
  type WatchLoop,
} from "../../lib/schedules.ts";
import { readRuns, runScheduleNow } from "../../lib/session.ts";
import { type JuneSettings } from "../../lib/settings.ts";

function RunNowButton({ id, disabled }: { id: string; disabled: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const run = () => {
    setNote(null);
    void runScheduleNow(id)
      .then(() => setNote("Started - watch the Runs tab."))
      .catch((e) => setNote(msg(e)));
  };
  return (
    <>
      <button onClick={run} disabled={disabled} title="Run this saved schedule once now">
        Run now
      </button>
      {note && <span className="settings-hint">{note}</span>}
    </>
  );
}

// --- Automation (Phase 18) ------------------------------------------------
// Scheduled runs and file-watch triggers. Both fire UNATTENDED: any action that
// needs approval is blocked automatically (18.2), never auto-approved, and the
// audit log records everything the run did. All opt-in, off by default.

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The run ledger, for the automation cards' last-outcome line (6.2). Refreshes on
 *  `runs://updated` so a run that just landed shows without reopening Settings. */
function useRuns(): RunRecord[] {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  useEffect(() => {
    const load = () => void readRuns().then(setRuns);
    load();
    const unlisten = listen("runs://updated", load);
    return () => void unlisten.then((f) => f());
  }, []);
  return runs;
}

/** Confirmation line under an automation card (6.2): the next fire time (schedules
 *  only - triggers and watches have no clock the UI can anchor) and the last matching
 *  ledger outcome, so a card is no longer write-only. */
function CardStatus({ next, source, runs }: { next?: string; source: string; runs: RunRecord[] }) {
  const last = lastRunFor(runs, source);
  return (
    <p className="card-status">
      {next && <span className="card-next">{next}</span>}
      {last ? (
        <span className={`card-last ${last.isError ? "bad" : "ok"}`}>
          {last.isError ? "✗" : "✓"} last ran {relativeTime(last.started)}
          {last.blocked.length > 0 ? ` (${last.blocked.length} blocked)` : ""}
        </span>
      ) : (
        <span className="card-last">no runs yet</span>
      )}
    </p>
  );
}

export function AutomationSection({
  settings,
  update,
}: {
  settings: JuneSettings;
  update: (s: JuneSettings) => void;
}) {
  const { schedules, triggers, watches } = settings;
  const runs = useRuns();
  const now = new Date();

  const setSchedules = (next: Schedule[]) => update({ ...settings, schedules: next });
  const setTriggers = (next: FileTrigger[]) => update({ ...settings, triggers: next });
  const setWatches = (next: WatchLoop[]) => update({ ...settings, watches: next });

  const freshId = (base: string, taken: { id: string }[]): string => {
    if (!taken.some((t) => t.id === base)) return base;
    for (let n = 2; ; n++) if (!taken.some((t) => t.id === `${base}-${n}`)) return `${base}-${n}`;
  };

  const addSchedule = () =>
    setSchedules([
      ...schedules,
      {
        id: freshId("schedule", schedules),
        label: "New schedule",
        prompt: "",
        kind: "daily",
        time: "09:00",
        days: [],
        everyMinutes: 60,
        at: "",
        enabled: false,
      },
    ]);
  const addTrigger = () =>
    setTriggers([
      ...triggers,
      {
        id: freshId("trigger", triggers),
        label: "New trigger",
        path: "",
        prompt: "",
        enabled: false,
      },
    ]);
  const addWatch = () =>
    setWatches([
      ...watches,
      {
        id: freshId("watch", watches),
        label: "New watch",
        prompt: "",
        everyMinutes: 10,
        untilCondition: "",
        enabled: false,
      },
    ]);

  const patchSchedule = (id: string, p: Partial<Schedule>) =>
    setSchedules(schedules.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const patchTrigger = (id: string, p: Partial<FileTrigger>) =>
    setTriggers(triggers.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const patchWatch = (id: string, p: Partial<WatchLoop>) =>
    setWatches(watches.map((w) => (w.id === id ? { ...w, ...p } : w)));

  return (
    <section className="settings-section">
      <h2>Automation</h2>
      <p className="settings-hint">
        June can run on a schedule or when a file changes - <strong>unattended</strong>. Any action
        that needs approval is blocked automatically and you're notified; June never approves its
        own actions. Every run is in the audit log.
      </p>

      <h3 className="settings-subhead">Scheduled runs</h3>
      {schedules.map((s) => (
        <div key={s.id} className="stage-card">
          <div className="stage-row">
            <input
              className="wide"
              value={s.label}
              onChange={(e) => patchSchedule(s.id, { label: e.target.value })}
              placeholder="Morning briefing"
            />
            <label className="wake-toggle">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => patchSchedule(s.id, { enabled: e.target.checked })}
              />
              <span>Enabled</span>
            </label>
            <RunNowButton id={s.id} disabled={!s.prompt.trim()} />
            <button onClick={() => setSchedules(schedules.filter((x) => x.id !== s.id))}>
              Remove
            </button>
          </div>
          {/* A `once` reminder (improvement-6 4.1) is created by voice and retires
              itself after firing, so it is read-only here - only its one-time fire
              time is shown, not the recurring daily/every controls. */}
          {s.kind === "once" ? (
            <div className="stage-row">
              <span className="stage-label">Reminder</span>
              <span className="settings-hint">one-time at {s.at || "—"} (created by voice)</span>
            </div>
          ) : (
            <div className="stage-row">
              <span className="stage-label">Repeat</span>
              <select
                value={s.kind}
                onChange={(e) =>
                  patchSchedule(s.id, { kind: e.target.value === "every" ? "every" : "daily" })
                }
                title="How this schedule recurs"
                aria-label="How this schedule recurs"
              >
                <option value="daily">Daily at a time</option>
                <option value="every">Every N minutes</option>
              </select>
            </div>
          )}
          {s.kind === "once" ? null : s.kind === "every" ? (
            <div className="stage-row">
              <span className="stage-label">Every</span>
              <input
                type="number"
                min={1}
                className="num"
                value={s.everyMinutes}
                onChange={(e) =>
                  patchSchedule(s.id, {
                    everyMinutes: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                  })
                }
              />
              <span className="settings-hint">minutes</span>
            </div>
          ) : (
            <div className="stage-row">
              <span className="stage-label">At</span>
              <input
                type="time"
                value={s.time}
                aria-label="Time of day"
                onChange={(e) => patchSchedule(s.id, { time: e.target.value || "09:00" })}
              />
              <span className="settings-hint">
                {DAY_LABELS.map((lbl, d) => {
                  const on = s.days.includes(d);
                  return (
                    <button
                      key={d}
                      className={on ? "day-on" : "day-off"}
                      aria-pressed={on}
                      aria-label={DAY_NAMES[d]}
                      onClick={() =>
                        patchSchedule(s.id, {
                          days: on
                            ? s.days.filter((x) => x !== d)
                            : [...s.days, d].sort((a, b) => a - b),
                        })
                      }
                    >
                      {lbl}
                    </button>
                  );
                })}
                {s.days.length === 0 ? " every day" : ""}
              </span>
            </div>
          )}
          <textarea
            className="memory-text"
            value={s.prompt}
            onChange={(e) => patchSchedule(s.id, { prompt: e.target.value })}
            placeholder="Give me a short briefing of today's calendar and any unread priority mail."
            rows={2}
          />
          <CardStatus next={describeNext(s, now)} source={`schedule: ${s.label}`} runs={runs} />
        </div>
      ))}
      <div className="settings-test">
        <button onClick={addSchedule}>Add schedule</button>
      </div>

      <h3 className="settings-subhead">File triggers</h3>
      <p className="settings-hint">
        When the watched file changes, June opens an investigation with the file's new contents as
        context. That content is treated as <strong>untrusted</strong> - information only, never
        instructions - and can never authorize an action.
      </p>
      {triggers.map((t) => (
        <div key={t.id} className="stage-card">
          <div className="stage-row">
            <input
              className="wide"
              value={t.label}
              onChange={(e) => patchTrigger(t.id, { label: e.target.value })}
              placeholder="Error log watch"
            />
            <label className="wake-toggle">
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={(e) => patchTrigger(t.id, { enabled: e.target.checked })}
              />
              <span>Enabled</span>
            </label>
            <button onClick={() => setTriggers(triggers.filter((x) => x.id !== t.id))}>
              Remove
            </button>
          </div>
          <div className="stage-row">
            <span className="stage-label">Watch file</span>
            <input
              className="wide"
              value={t.path}
              onChange={(e) => patchTrigger(t.id, { path: e.target.value })}
              placeholder="C:\logs\app\error.log"
            />
          </div>
          <textarea
            className="memory-text"
            value={t.prompt}
            onChange={(e) => patchTrigger(t.id, { prompt: e.target.value })}
            placeholder="Summarize the newest error and suggest a likely cause."
            rows={2}
          />
          <CardStatus source={`trigger: ${t.label}`} runs={runs} />
        </div>
      ))}
      <div className="settings-test">
        <button onClick={addTrigger}>Add trigger</button>
      </div>

      <h3 className="settings-subhead">Watch loops</h3>
      <p className="settings-hint">
        June re-checks something on an interval and stops when a condition holds - "check the build
        every ten minutes until it's green". Each check is <strong>unattended</strong>{" "}
        (observe-only), and June stops after {30} checks even if the condition never comes true.
      </p>
      {watches.map((w) => (
        <div key={w.id} className="stage-card">
          <div className="stage-row">
            <input
              className="wide"
              value={w.label}
              onChange={(e) => patchWatch(w.id, { label: e.target.value })}
              placeholder="Build watch"
            />
            <label className="wake-toggle">
              <input
                type="checkbox"
                checked={w.enabled}
                onChange={(e) => patchWatch(w.id, { enabled: e.target.checked })}
              />
              <span>Enabled</span>
            </label>
            <button onClick={() => setWatches(watches.filter((x) => x.id !== w.id))}>Remove</button>
          </div>
          <div className="stage-row">
            <span className="stage-label">Every</span>
            <input
              type="number"
              min={1}
              className="num"
              value={w.everyMinutes}
              onChange={(e) =>
                patchWatch(w.id, {
                  everyMinutes: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                })
              }
            />
            <span className="settings-hint">minutes</span>
          </div>
          <textarea
            className="memory-text"
            value={w.prompt}
            onChange={(e) => patchWatch(w.id, { prompt: e.target.value })}
            placeholder="Check whether the CI build for the main branch has finished."
            rows={2}
          />
          <div className="stage-row">
            <span className="stage-label">Until</span>
            <input
              className="wide"
              value={w.untilCondition}
              onChange={(e) => patchWatch(w.id, { untilCondition: e.target.value })}
              placeholder="the build is green"
            />
          </div>
          <div className="stage-row">
            <span className="stage-label">Stop after</span>
            <input
              type="number"
              min={1}
              className="num"
              value={w.maxChecks ?? ""}
              placeholder="30"
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                patchWatch(w.id, { maxChecks: Number.isFinite(n) && n >= 1 ? n : undefined });
              }}
            />
            <span className="settings-hint">checks (blank = 30)</span>
          </div>
          <CardStatus
            next={`Every ${w.everyMinutes} min`}
            source={`watch: ${w.label}`}
            runs={runs}
          />
        </div>
      ))}
      <div className="settings-test">
        <button onClick={addWatch}>Add watch loop</button>
      </div>
    </section>
  );
}
