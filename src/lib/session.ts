import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

import { coerceMission, type Mission } from "./missions.ts";
import { coerceRuns, type RunRecord } from "./runs.ts";

// Cross-window session glue (PLAN.md Phase 6). The Rust backend broadcasts every
// step of an agent turn as an `agent://*` event to ALL windows, so the always-on
// widget and the on-demand full app render the same session. Approvals are shared
// here so a gated command started in one window can be approved in the other.

/** A gated tool call awaiting a human decision (Rust `PendingApproval`). */
export type Approval = {
  turn: number;
  id: number;
  action: string;
  summary: string;
  cls: string;
  /** When the backend will expire (deny) the gate, in epoch ms. Stamped locally
   *  when the live `agent://approval` event arrives; absent on an approval seeded
   *  from `pending_approval` (its start time is unknown - show no countdown). */
  deadline?: number;
};

/** Mirrors agent/serve.ts APPROVAL_TIMEOUT_MS: the gate denies itself after this. */
const APPROVAL_TIMEOUT_MS = 120_000;

/** How long the "that approval timed out" note lingers before clearing. */
const EXPIRED_NOTE_MS = 6_000;

/** Approve or reject the pending gated action. The decision is written to the
 *  running agent's stdin by the backend; the gate lives in the execution layer,
 *  so this is the only way a gated action ever runs (PLAN.md §5). */
export function resolveApproval(id: number, decision: "allow" | "deny"): Promise<void> {
  return invoke("resolve_approval", { id, decision });
}

/** Open (or focus) the full application window. */
export function openApp(): Promise<void> {
  return invoke("show_app");
}

// Turn-number spaces (B3.7). Each webview counts its OWN turns, but a webview
// reload resets its counter - so a reused number would replace a still-registered
// `Sender` in the shared Rust `turns` map, orphaning (and shutting down) the
// resident. Seed each counter from a monotonic per-load base (ms since a fixed
// epoch) instead of a constant, so a fresh load never reuses the prior load's
// in-flight numbers. The three spaces stay ordered and below the Rust unattended
// base (2^40): interactive < mission < unattended, each with room for a load's base
// plus its turns.
// ponytail: the epoch offset keeps the base under 2^39 until ~2037; widen the epoch
// or the band if June is still counting turns then.
const TURN_EPOCH = 1_577_836_800_000; // 2020-01-01 UTC

/** Per-load base for the widget's interactive turns (below the 2^39 mission band,
 *  which the Rust-side mission runner owns since improvement-5 P2 5.2). */
export function interactiveTurnBase(): number {
  return Date.now() - TURN_EPOCH; // ~2e11, well under 2^39
}

// One shared allocator for THIS webview's non-widget interactive turns: the app
// window's text composer and mission planning both dispatch turns, and a single
// counter keeps them from ever reusing a number. The widget webview keeps its own
// counter in VoicePanel (a different window, different base).
let appTurn = interactiveTurnBase();

/** Allocate the next interactive-band turn number for app-window dispatches. */
export function allocTurn(): number {
  return appTurn++;
}

/** Abort an in-flight turn (Phase 11.3). Barge-in and Cancel call this so the
 *  resident interrupts the brain mid-generation - the turn stops spending tokens
 *  at once instead of running to completion unheard. Fire-and-forget: an already
 *  finished turn (or no live resident) is a harmless no-op on the backend. */
export function cancelAgent(turn: number): Promise<void> {
  return invoke("cancel_agent", { turn });
}

/** Start a fresh conversation (Phase 11.2). Drops the resident's memory and
 *  clears the shared transcript in every window; the backend broadcasts
 *  `agent://reset` so both faces empty out. */
export function newConversation(): Promise<void> {
  return invoke("new_conversation");
}

/**
 * The current pending approval, shared across windows. Seeds from the backend on
 * mount (a full-app window opened mid-approval still sees the prompt), then
 * tracks live `agent://approval` / `agent://approval-resolved` / `agent://final`
 * events so both windows show and clear the same prompt.
 */
export function usePendingApproval(): {
  approval: Approval | null;
  decide: (decision: "allow" | "deny") => void;
  expired: boolean;
} {
  const [approval, setApproval] = useState<Approval | null>(null);
  // True briefly after a pending gate timed out on the backend (improvement-5
  // P0.9): the card must not just silently vanish - the surfaces show a note.
  const [expired, setExpired] = useState(false);
  const ref = useRef<Approval | null>(null);
  ref.current = approval;

  useEffect(() => {
    let alive = true;
    void invoke<Approval | null>("pending_approval").then((a) => {
      if (alive && a && !ref.current) setApproval(a);
    });
    const unlisten = [
      listen<Approval>("agent://approval", (e) => {
        setExpired(false);
        // Stamp the deadline locally: the event marks the gate's start, and the
        // backend denies it APPROVAL_TIMEOUT_MS later (serve.ts).
        setApproval({ ...e.payload, deadline: Date.now() + APPROVAL_TIMEOUT_MS });
      }),
      listen<{ id: number; reason?: string }>("agent://approval-resolved", (e) => {
        if (ref.current && ref.current.id === e.payload.id) {
          setApproval(null);
          if (e.payload.reason === "expired") setExpired(true);
        }
      }),
      listen<{ turn: number }>("agent://final", (e) => {
        if (ref.current && ref.current.turn === e.payload.turn) setApproval(null);
      }),
    ];
    return () => {
      alive = false;
      unlisten.forEach((p) => void p.then((f) => f()));
    };
  }, []);

  useEffect(() => {
    if (!expired) return;
    const id = window.setTimeout(() => setExpired(false), EXPIRED_NOTE_MS);
    return () => window.clearTimeout(id);
  }, [expired]);

  // Stable identity so callers (e.g. barge-in / cancel) can deny a pending
  // approval from inside their own memoized callbacks without dep churn.
  const decide = useCallback((decision: "allow" | "deny") => {
    const a = ref.current;
    if (!a) return;
    setApproval(null); // optimistic; the resolved/final event confirms for the other window
    void resolveApproval(a.id, decision).catch(() => {
      // The write failed (transient IPC error): the gate may still be pending on the
      // backend, so restore the card rather than silently dropping it (B4.10). If it
      // was genuinely already resolved, a resolved/final event re-clears it.
      setApproval((cur) => cur ?? a);
    });
  }, []);

  return { approval, decide, expired };
}

// --- Missions (Phase 19.1) ---
// The current mission board, persisted by Rust as `june-mission.json` and
// broadcast as `mission://updated` so BOTH faces stay in sync. `writeMission`
// stores the JSON (an empty string clears it); the app's runner drives it, the
// widget just watches.

/** Read the current mission board (null when there is no active mission). The whole
 *  body is guarded so a missing backend, a rejected invoke, or a corrupt file all
 *  read as "no mission" instead of throwing into the mount effect. */
export async function readMission(): Promise<Mission | null> {
  try {
    const raw = await invoke<string>("read_mission");
    if (!raw.trim()) return null;
    return coerceMission(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist the mission board and broadcast it to both faces. Pass null to clear. */
export function writeMission(mission: Mission | null): Promise<void> {
  return invoke("write_mission", { content: mission ? JSON.stringify(mission) : "" });
}

/** The run-history ledger (improvement-5 P1.3), newest first. Guarded so a missing
 *  backend / rejected invoke / corrupt line all read as "no runs" rather than
 *  throwing into the Runs panel. */
export async function readRuns(): Promise<RunRecord[]> {
  try {
    return coerceRuns(await invoke<unknown>("read_runs"));
  } catch {
    return [];
  }
}

/** Purge all recorded activity (7.11): the run ledger and the audit log. The
 *  user's explicit "forget what I've done"; the backend emits `runs://updated` so
 *  an open Runs tab empties at once. Rejects with a message if a file couldn't be
 *  deleted (e.g. locked), so the UI can say data may remain. */
export function clearRecordedData(): Promise<void> {
  return invoke("clear_recorded_data");
}

/** Fire a schedule on demand (2.4 "Run now"): a one-off unattended run so a user
 *  can test a 9am briefing without waiting for 9am or editing its time. Rejects
 *  if the schedule is gone or June is mid-turn. */
export function runScheduleNow(id: string): Promise<void> {
  return invoke("run_schedule_now", { id });
}

/** Pause or resume the running mission (5.3): holds the board BETWEEN tasks so
 *  "hold on while I take this call" costs nothing, unlike Stop. */
export function setMissionPaused(paused: boolean): Promise<void> {
  return invoke("set_mission_paused", { paused });
}

/** Whether the running mission is paused (5.3), shared across windows. Seeds from
 *  the backend on mount, then tracks `mission://paused`. Memory-only on the Rust
 *  side (a restart resumes unpaused), so this reflects the live session's flag. */
export function useMissionPaused(): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    void invoke<boolean>("mission_paused")
      .then((p) => {
        if (alive) setPaused(!!p);
      })
      .catch(() => {});
    const unlisten = listen<boolean>("mission://paused", (e) => setPaused(!!e.payload));
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, []);
  return paused;
}

/** The current mission, shared across windows. Seeds from the backend on mount,
 *  then tracks `mission://updated`, so the widget's chip and the app's board
 *  render the same live board. */
export function useMission(): Mission | null {
  const [mission, setMission] = useState<Mission | null>(null);
  useEffect(() => {
    let alive = true;
    let gotEvent = false;
    void readMission().then((m) => {
      // Don't let a slow initial file read clobber a live event that already landed
      // (B4.10): the broadcast is newer than whatever the file held at mount.
      if (alive && !gotEvent) setMission(m);
    });
    const unlisten = listen<unknown>("mission://updated", (e) => {
      gotEvent = true;
      setMission(coerceMission(e.payload));
    });
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, []);
  return mission;
}
