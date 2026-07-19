import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

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
};

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
} {
  const [approval, setApproval] = useState<Approval | null>(null);
  const ref = useRef<Approval | null>(null);
  ref.current = approval;

  useEffect(() => {
    let alive = true;
    void invoke<Approval | null>("pending_approval").then((a) => {
      if (alive && a && !ref.current) setApproval(a);
    });
    const unlisten = [
      listen<Approval>("agent://approval", (e) => setApproval(e.payload)),
      listen<{ id: number }>("agent://approval-resolved", (e) => {
        if (ref.current && ref.current.id === e.payload.id) setApproval(null);
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

  // Stable identity so callers (e.g. barge-in / cancel) can deny a pending
  // approval from inside their own memoized callbacks without dep churn.
  const decide = useCallback((decision: "allow" | "deny") => {
    const a = ref.current;
    if (!a) return;
    setApproval(null); // optimistic; the resolved/final event confirms for the other window
    void resolveApproval(a.id, decision);
  }, []);

  return { approval, decide };
}
