import { type Ref, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { humanizeAction } from "../lib/actions.ts";
import { useApprovalKeys } from "../lib/approval-hooks.ts";
import { ApprovalMeta } from "../lib/approval-ui.tsx";
import { usePttLabel } from "../lib/hotkey.ts";
import { formatModelProgress, MODEL_PROGRESS_EVENT, type ModelProgress } from "../lib/model-progress.ts";
import { PRIVACY_MODES, type PrivacyMode } from "../lib/privacy.ts";
import { followBottom } from "../lib/scroll.ts";
import { allocTurn, type Approval, newConversation, usePendingApproval } from "../lib/session.ts";
import { type JuneSettings, loadSettings, saveSettings } from "../lib/settings.ts";
import { runAgent } from "../lib/stt.ts";
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
  | { kind: "june"; key: string; turn: number; text: string; at: number }
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
            return [...xs, { kind: "june", key: key(), turn: p.turn, text: p.delta, at: Date.now() }];
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
            return [...xs, { kind: "june", key: key(), turn: p.turn, text: p.text, at: Date.now() }];
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
  const pttLabel = usePttLabel(); // 6.6: the chord is configurable now
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("chat");
  // Transient failure note (improvement-5 P0.7): a failed invoke must not look
  // like a button that did nothing.
  const [note, setNote] = useState<string | null>(null);
  // 7.12: a positive transient toast (distinct from the red failure `note`) - e.g.
  // a keychain change confirmation, so a key save/remove doesn't happen silently.
  const [flash, setFlash] = useState<string | null>(null);
  // Unseen-runs badge (2.4): a run that lands while the user is on another tab
  // should announce itself, so a scheduled result isn't missed. Set on
  // `runs://updated` off the Runs tab; cleared when the Runs tab is opened.
  const [runsUnseen, setRunsUnseen] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const unlisten = listen("runs://updated", () => {
      if (viewRef.current !== "runs") setRunsUnseen(true);
    });
    return () => void unlisten.then((f) => f());
  }, []);
  useEffect(() => {
    if (view === "runs") setRunsUnseen(false);
  }, [view]);

  // First-run onboarding (6.4): a fresh install is an unexplained floating dot.
  // Load settings once; if the one-time welcome hasn't been dismissed, show it.
  const [settings, setSettings] = useState<JuneSettings | null>(null);
  useEffect(() => {
    void loadSettings().then(setSettings).catch(() => {});
  }, []);
  // On-device voice setup progress (improvement-7 1.5). The download usually runs
  // in the widget webview (or this window's settings preload); the aggregate is
  // rebroadcast over Tauri, so the onboarding card can show one honest row.
  const [modelSetup, setModelSetup] = useState<ModelProgress>(null);
  useEffect(() => {
    const unlisten = listen<ModelProgress>(MODEL_PROGRESS_EVENT, (e) => setModelSetup(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  const finishOnboarding = (openSettings: boolean) => {
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s, firstRunDone: true };
      void saveSettings(next).catch(() => {});
      return next;
    });
    if (openSettings) setView("settings");
  };

  // Sticky-bottom, not forced (improvement-5 P0.8): a reader who scrolled up
  // stays put; a reader at the bottom follows the stream, instantly.
  useEffect(() => {
    followBottom(scroller.current);
  }, [entries, approval]);

  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(id);
  }, [note]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 3000);
    return () => window.clearTimeout(id);
  }, [flash]);

  // 7.12: confirm a keychain change (set/delete) with a toast so it isn't silent.
  useEffect(() => {
    const unlisten = listen<{ action?: string; scope?: string }>("keychain://changed", (e) => {
      const thing = e.payload?.scope === "mcp" ? "Server secret" : "API key";
      setFlash(e.payload?.action === "deleted" ? `${thing} removed.` : `${thing} saved.`);
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // Keyboard routes (6.6): Ctrl+1..4 switch views, "/" jumps to the composer -
  // one window-level listener, mirroring useApprovalKeys. "/" is ignored while
  // typing in a field so a draft containing a slash isn't hijacked.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const VIEW_KEYS: Record<string, View> = { "1": "chat", "2": "missions", "3": "runs", "4": "settings" };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && VIEW_KEYS[e.key]) {
        e.preventDefault();
        setView(VIEW_KEYS[e.key]);
      } else if (e.key === "/" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        setView("chat");
        // The composer may be mounting right now (view switch); focus after commit.
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tab = (v: View, label: string) => (
    <button className={view === v ? "active" : ""} aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}>
      {label}
      {v === "runs" && runsUnseen && <span className="tab-badge" aria-label="new runs" />}
    </button>
  );

  return (
    <div className="app-window">
      {settings && !settings.firstRunDone && (
        <Onboarding
          settings={settings}
          pttLabel={pttLabel}
          modelSetup={modelSetup}
          onPrivacy={(mode) =>
            setSettings((s) => {
              if (!s) return s;
              const next = { ...s, privacyMode: mode };
              void saveSettings(next).catch(() => {});
              return next;
            })
          }
          onLaunchAtLogin={(on) =>
            setSettings((s) => {
              if (!s) return s;
              const next = { ...s, launchAtLogin: on };
              void saveSettings(next).catch(() => {});
              return next;
            })
          }
          onDone={finishOnboarding}
        />
      )}
      <header className="app-header">
        <div className="app-title">June</div>
        <nav className="app-nav">
          {tab("chat", "Conversation")}
          {tab("missions", "Missions")}
          {tab("runs", "Runs")}
          {tab("settings", "Settings")}
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
        <div className="app-sub" role="status">
          <span className={`status-dot ${working ? "busy" : ""}`} aria-hidden="true" />
          {working ? "Working…" : `Ready. Type below, speak to the widget, or hold ${pttLabel}.`}
        </div>
      </header>

      {/* Approvals stay visible in both views, so a gated command can be granted
          from the settings screen too. */}
      {approval && <ApprovalBanner approval={approval} onDecide={decide} />}
      {expired && (
        <p className="err app-note" role="alert">
          That approval timed out, so June didn't act.
        </p>
      )}
      {note && (
        <p className="err app-note" role="alert">
          {note}
        </p>
      )}
      {flash && (
        <p className="app-note app-flash" role="status">
          {flash}
        </p>
      )}

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
                Nothing yet. Type a command below or hold {pttLabel} and speak - your commands, June's replies, and
                every action it takes appear here live.
              </p>
            )}
            {entries.map((e) => (
              <ConversationEntry key={e.key} entry={e} />
            ))}
          </div>
          <Composer onError={setNote} fieldRef={composerRef} />
        </>
      )}
    </div>
  );
}

/** One-time first-run welcome (6.4). A fresh install otherwise opens to an
 *  unexplained floating dot: this orients the user - how to talk to June (the PTT
 *  chord), a privacy-mode choice up front (the one decision that changes what
 *  leaves the device), and a route into Settings to test the mic (which lives
 *  there already, so we don't duplicate the control). Dismissed once via the
 *  `firstRunDone` flag; never shown again. */
function Onboarding({
  settings,
  pttLabel,
  modelSetup,
  onPrivacy,
  onLaunchAtLogin,
  onDone,
}: {
  settings: JuneSettings;
  pttLabel: string;
  modelSetup: ModelProgress;
  onPrivacy: (mode: PrivacyMode) => void;
  onLaunchAtLogin: (on: boolean) => void;
  onDone: (openSettings: boolean) => void;
}) {
  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Welcome to June">
      <div className="onboarding-card">
        <h1>Welcome to June</h1>
        <p>
          June is a voice-first assistant that lives in the corner of your screen. Hold <kbd>{pttLabel}</kbd> and speak,
          or just type in the box below - your commands, June's replies, and every action it takes appear in the
          Conversation view.
        </p>

        <div className="onboarding-privacy">
          <span className="onboarding-label">Choose a privacy mode</span>
          {PRIVACY_MODES.map((m) => (
            <label key={m.id} className="privacy-mode">
              <input
                type="radio"
                name="onboarding-privacy"
                checked={settings.privacyMode === m.id}
                onChange={() => onPrivacy(m.id as PrivacyMode)}
              />
              <span>
                <span className="privacy-name">{m.label}</span>
                <span className="privacy-desc">{m.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {/* One aggregate on-device setup row (improvement-7 1.5), shown only while
            a local voice model is actually downloading. */}
        {modelSetup && (
          <p className="onboarding-progress" role="status">
            Setting up on-device voice
            {formatModelProgress(modelSetup) ? ` (${formatModelProgress(modelSetup)})` : "…"} - one-time download.
          </p>
        )}

        {/* Offered once at first run (improvement-7 1.3); changeable any time in
            Settings -> Activation. Default off - autostart is the user's call. */}
        <label className="wake-toggle onboarding-autostart">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => onLaunchAtLogin(e.target.checked)}
          />
          <span>
            <span className="privacy-name">Start June at login</span>
            <span className="privacy-desc">So wake word, push to talk and schedules survive a reboot.</span>
          </span>
        </label>

        <div className="onboarding-actions">
          <button className="primary" onClick={() => onDone(true)}>
            Open Settings to test your mic
          </button>
          <button onClick={() => onDone(false)}>Start using June</button>
        </div>
      </div>
    </div>
  );
}

/** Text path to the same agent session (improvement-5 P2 6.1): voice and keyboard
 *  are equals now. Enter sends (Shift+Enter for a newline); the reply streams into
 *  the conversation above via the shared agent://* events. Sending while June is
 *  working preempts the active turn, exactly like barging in by voice. */
function Composer({ onError, fieldRef }: { onError: (m: string) => void; fieldRef?: Ref<HTMLTextAreaElement> }) {
  const [text, setText] = useState("");
  // Last sent command, for ArrowUp recall (6.3) - the raw text (newlines kept).
  const lastSent = useRef("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    lastSent.current = text;
    setText("");
    void runAgent(t, allocTurn()).catch((e) => onError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <footer className="app-composer">
      <textarea
        ref={fieldRef}
        rows={1}
        value={text}
        placeholder="Type a command for June…"
        aria-label="Type a command for June"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === "ArrowUp" && text === "" && lastSent.current) {
            // Recall the last command only from an empty box, so ArrowUp still
            // navigates lines within a draft.
            e.preventDefault();
            setText(lastSent.current);
          }
        }}
      />
      <button className="primary" disabled={!text.trim()} onClick={send}>
        Send
      </button>
    </footer>
  );
}

function ConversationEntry({ entry }: { entry: Entry }) {
  if (entry.kind === "you") return <div className="turn you">{entry.text}</div>;
  if (entry.kind === "june") return <JuneBubble entry={entry} />;
  // Humanized name + a pulse while the call has no result yet (6.7): the chip
  // reads "read file", not raw snake_case, and running state is visible.
  const running = entry.result === undefined;
  return (
    <div className={`turn tool ${entry.error ? "tool-error" : ""} ${running ? "tool-running" : ""}`}>
      <span className="tool-name">{humanizeAction(entry.action)}</span>
      {entry.result && <span className="tool-result"> - {entry.result}</span>}
    </div>
  );
}

/** A June reply bubble with a hover-revealed copy button + timestamp (6.5). Replies
 *  carry paths and commands and the only route out was manual selection. */
function JuneBubble({ entry }: { entry: Extract<Entry, { kind: "june" }> }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(entry.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  const time = new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="turn june">
      {entry.text}
      <span className="turn-meta">
        <span className="turn-time">{time}</span>
        <button className="turn-copy" onClick={copy} title="Copy reply" aria-label="Copy reply">
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
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
