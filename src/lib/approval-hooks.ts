import { type RefObject, useEffect, useRef, useState } from "react";

import type { Approval } from "./session.ts";

// Shared approval-surface behaviour for both faces (improvement-5 P0.9): the
// visible expiry countdown and a keyboard path for the most safety-critical
// control in the product. The chip/countdown markup lives in approval-ui.tsx.

function remaining(a: Approval): number | null {
  return a.deadline === undefined ? null : Math.max(0, Math.ceil((a.deadline - Date.now()) / 1000));
}

/** Seconds until the backend expires the gate (agent/serve.ts denies at 120s), or
 *  null when the deadline is unknown - an approval seeded from `pending_approval`
 *  by a window opened mid-gate carries no start time, and a wrong countdown would
 *  be worse than none. */
export function useApprovalCountdown(approval: Approval): number | null {
  const [left, setLeft] = useState<number | null>(() => remaining(approval));
  useEffect(() => {
    setLeft(remaining(approval));
    if (approval.deadline === undefined) return;
    const id = window.setInterval(() => setLeft(remaining(approval)), 1000);
    return () => window.clearInterval(id);
  }, [approval]);
  return left;
}

/** Focus the safe (Reject) button when a gate appears and reject on Esc, so a
 *  gated action never requires a mouse. Returns the ref to put on Reject. */
export function useApprovalKeys(
  approvalId: number,
  onDecide: (d: "allow" | "deny") => void,
): RefObject<HTMLButtonElement | null> {
  const rejectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    rejectRef.current?.focus();
  }, [approvalId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecide("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecide]);
  return rejectRef;
}
