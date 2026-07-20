import { useApprovalCountdown } from "./approval-hooks.ts";
import type { Approval } from "./session.ts";

/** The danger-class chip + expiry countdown both approval surfaces share
 *  (improvement-5 P0.9): the gate shows WHAT tier of action wants to run and how
 *  long before June cancels it, instead of silently vanishing at timeout. */
export function ApprovalMeta({ approval }: { approval: Approval }) {
  const left = useApprovalCountdown(approval);
  return (
    <>
      <span className="approval-cls">{approval.cls}</span>
      {left !== null && (
        <span className="approval-timer" title="With no answer, June cancels this action when the timer runs out.">
          {left}s
        </span>
      )}
    </>
  );
}
