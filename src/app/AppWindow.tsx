import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useApprovalKeys } from "../lib/approval-hooks.ts";
import { ApprovalMeta } from "../lib/approval-ui.tsx";
import { recoverInterruptedMission } from "../lib/mission-runner.ts";
import { followBottom } from "../lib/scroll.ts";
import { type Approval, newConversation, usePendingApproval } from "../lib/session.ts";
import { MissionBoard } from "./MissionBoard.tsx";
import { RunsPanel } from "./RunsPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";

// The full application window (PLAN.md Phase 6). It shares the agent session with
// the widget: the backend broadcasts every step of a turn as an `agent://*`
// event, so a command started by voice in the widget shows up here as a running
// conversation and its approvals can be granted here. It does NOT own the mic or
// speak - the widget owns the voice pipeline; this window inspects and approves.
//
// Phase 7 adds the second face: the Settings panel (models, keys, privacy,
// diagnostics). It is mounted only when selected, so the conversation stays the
// default view and nothing loads settings until the user asks for them.

type Entry =
  | { kind: "you"; key: string; turn: number; text: string }
  | { kind: "june"; key: string; turn: number; text: string }
  | { kind: "tool"; key: string; turn: number; action: string; result?: string; error?: boolean };

/** Compact, human-readable outcome for a tool result - counts when the bridge
 *  returns a batch, otherwise a short done/failed. */
function summarizeResult(res: unknown, isError: boolean): string {
  const counts = (res as { counts?: Record<string, number> } | null)?.counts;
  if (counts && typeof counts.started === "number") {
    const total = counts.requested ?? counts.started;
    const failed = counts.failed ?? 0;
    return `started ${counts.started} of ${total}${failed ? `, ${failed} failed` : ""}`;
  }
  return isError ? "failed" : "done";
}

/** A recorded session event, as returned by the `session_events` command. */
type SessionEvent = { name: string; payload: Record<string, unknown> };

/** Builds the conversation from the `agent://*` events: first a replay of the
 *  backend's recorded session log (so a window opened mid-session still shows
 *  everything), then live deliveries. Also reports whether a turn is in flight
 *  so the header can show a working state. */
function useConversation(): { entries: Entry[]; working: boolean } {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [working, setWorking] = useState(false);
  const active = useRef<Set<number>>(new Set());
  const seq = useRef(0);

  useEffect(() => {
    // Rebuilt from scratch on every mount: the replay below restores history,
    // so stale state from a previous mount (StrictMode) must not survive.
    active.current.clear();
    setWorking(false);
    setEntries([]);

    const key = () => `e${seq.current++}`;
    const setBusy = () => setWorking(active.current.size > 0);

    const apply = (name: string, payload: Record<string, unknown>) => {
      switch (name) {
        case "agent://reset": {
          // A new conversation (explicit button or idle auto-reset) - empty the
          // transcript so this window reflects the fresh session.
          active.current.clear();
          setWorking(false);
          setEntries([]);
          break;
        }
        case "agent://user": {
          const p = payload as { turn: number; text: string };
          active.current.add(p.turn);
          setBusy();
          setEntries((xs) => [...xs, { kind: "you", key: key(), turn: p.turn, text: p.text }]);
          break;
        }
        case "agent://text": {
          const p = payload as { turn: number; delta: string };
          setEntries((xs) => {
            // Append the delta to this turn's latest June bubble, or start one.
            for (let i = xs.length - 1; i >= 0; i--) {
              const x = xs[i];
              if (x.turn === p.turn && x.kind === "june") {
                const next = [...xs];
                next[i] = { ...x, text: x.text + p.delta };
                return next;
              }
              if (x.turn === p.turn && x.kind === "tool") break; // a tool split the reply; new bubble
            }
            return [...xs, { kind: "june", key: key(), turn: p.turn, text: p.delta }];
          });
          break;
        }
        case "agent://tool": {
          const p = payload as { turn: number; action: string };
          setEntries((xs) => [...xs, { kind: "tool", key: key(), turn: p.turn, action: p.action }]);
          break;
        }
        case "agent://result": {
          const p = payload as { turn: number; action: string; res: unknown; isError: boolean };
          setEntries((xs) => {
            for (let i = xs.length - 1; i >= 0; i--) {
              const x = xs[i];
              if (x.kind === "tool" && x.turn === p.turn && x.action === p.action && x.result === undefined) {
                const next = [...xs];
                next[i] = { ...x, result: summarizeResult(p.res, p.isError), error: p.isError };
                return next;
              }
            }
            return xs;
          });
          break;
        }
        case "agent://final": {
          const p = payload as { turn: number; text: string };
          active.current.delete(p.turn);
          setBusy();
          setEntries((xs) => {
            // Prefer the authoritative final text as this turn's reply.
            for (let i = xs.length - 1; i >= 0; i--) {
              const x = xs[i];
              if (x.turn === p.turn && x.kind === "june") {
                const next = [...xs];
                next[i] = { ...x, text: p.text };
                return next;
              }
            }
            if (!p.text.trim()) return xs;
            return [...xs, { kind: "june", key: key(), turn: p.turn, text: p.text }];
          });
          break;
        }
      }
    };

    // Replay-then-live: live events arriving while the replay fetch is in
    // flight are buffered; the backend stamps recorded events with `seq`, which
    // deduplicates the overlap. Text deltas are live-only (never recorded - the
    // turn's `final` supersedes them), so they carry no seq and never collide.
    const seen = new Set<number>();
    let seeded = false;
    const buffered: SessionEvent[] = [];
    const receive = (name: string, payload: Record<string, unknown>) => {
      if (!seeded) {
        buffered.push({ name, payload });
        return;
      }
      if (typeof payload.seq === "number") {
        if (seen.has(payload.seq)) return;
        seen.add(payload.seq);
      }
      apply(name, payload);
    };

    const unlisten = ["agent://user", "agent://text", "agent://tool", "agent://result", "agent://final", "agent://reset"].map((n) =>
      listen<Record<string, unknown>>(n, (e) => receive(n, e.payload)),
    );

    void invoke<SessionEvent[]>("session_events")
      .then((history) => {
        for (const { name, payload } of history) {
          if (typeof payload.seq === "number") seen.add(payload.seq);
          apply(name, payload);
        }
      })
      .catch(() => {}) // no backend (tests / plain browser): live-only
      .finally(() => {
        seeded = true;
        for (const { name, payload } of buffered.splice(0)) receive(name, payload);
      });

    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, []);

  return { entries, working };
}

type View = "chat" | "missions" | "runs" | "settings";

export function AppWindow() {
  const { entries, working } = useConversation();
  const { approval, decide, expired } = usePendingApproval();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("chat");
  // Transient failure note (improvement-5 P0.7): a failed invoke must not look
  // like a button that did nothing.
  const [note, setNote] = useState<string | null>(null);

  // Sticky-bottom, not forced (improvement-5 P0.8): a reader who scrolled up
  // stays put; a reader at the bottom follows the stream, instantly.
  useEffect(() => {
    followBottom(scroller.current);
  }, [entries, approval]);

  // A mission whose runner died with this window (closed/reloaded mid-run) left
  // the board stuck "active" - close it out on mount (improvement-5 P0.3).
  useEffect(() => {
    void recoverInterruptedMission();
  }, []);

  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(id);
  }, [note]);

  return (
    <div className="app-window">
      <header className="app-header">
        <div className="app-title">June</div>
        <nav className="app-nav">
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
            Conversation
          </button>
          <button className={view === "missions" ? "active" : ""} onClick={() => setView("missions")}>
            Missions
          </button>
          <button className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}>
            Runs
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            Settings
          </button>
          <button
            className="new-convo"
            title="Start a new conversation - June forgets the current one"
            disabled={entries.length === 0 && !working}
            onClick={() =>
              void newConversation().catch(() => setNote("Couldn't reset the conversation. Try again."))
            }
          >
            New conversation
          </button>
        </nav>
        <div className="app-sub">
          <span className={`status-dot ${working ? "busy" : ""}`} aria-hidden="true" />
          {working ? "Working…" : "Ready. Speak to the widget or hold Ctrl + Shift + Space."}
        </div>
      </header>

      {/* Approvals stay visible in both views, so a gated command can be granted
          from the settings screen too. */}
      {approval && <ApprovalBanner approval={approval} onDecide={decide} />}
      {expired && <p className="err app-note">That approval timed out, so June didn't act.</p>}
      {note && <p className="err app-note">{note}</p>}

      {view === "settings" ? (
        <SettingsPanel />
      ) : view === "missions" ? (
        <MissionBoard />
      ) : view === "runs" ? (
        <RunsPanel />
      ) : (
        <>
          <div className="conversation" ref={scroller}>
            {entries.length === 0 && (
              <p className="empty">
                Nothing yet. Hold Ctrl + Shift + Space and speak - your commands, June's replies, and every action it
                takes appear here live.
              </p>
            )}
            {entries.map((e) => (
              <ConversationEntry key={e.key} entry={e} />
            ))}
          </div>
          <footer className="app-footer">Open Settings to choose your models, keys, and privacy mode.</footer>
        </>
      )}
    </div>
  );
}

function ConversationEntry({ entry }: { entry: Entry }) {
  if (entry.kind === "you") return <div className="turn you">{entry.text}</div>;
  if (entry.kind === "june") return <div className="turn june">{entry.text}</div>;
  return (
    <div className={`turn tool ${entry.error ? "tool-error" : ""}`}>
      <span className="tool-name">{entry.action}</span>
      {entry.result && <span className="tool-result"> - {entry.result}</span>}
    </div>
  );
}

function ApprovalBanner({ approval, onDecide }: { approval: Approval; onDecide: (d: "allow" | "deny") => void }) {
  // Keyboard path (improvement-5 P0.9): focus lands on the safe Reject button,
  // Esc rejects from anywhere in the window.
  const rejectRef = useApprovalKeys(approval.id, onDecide);
  return (
    <div className="app-approval">
      <div className="app-approval-text">
        <span className="approval-head">
          <span className="app-approval-label">Approval needed</span>
          <ApprovalMeta approval={approval} />
        </span>
        <span className="app-approval-what">{approval.summary}?</span>
      </div>
      <div className="row">
        <button className="primary" onClick={() => onDecide("allow")}>
          Approve
        </button>
        <button className="danger" ref={rejectRef} onClick={() => onDecide("deny")}>
          Reject
        </button>
      </div>
    </div>
  );
}
