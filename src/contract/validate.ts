// Runtime validation of bridge messages at the trust boundary. Small and
// explicit on purpose: no schema dependency, and each check maps to a frozen
// contract invariant (PLAN.md §2). June runs these on every bridge response;
// the contract tests run them on the golden examples.

import {
  ACTIONS,
  CONTRACT_VERSION,
  ERROR_CODES,
  MUTATING_ACTIONS,
  type Action,
  type Capabilities,
  type CommandRequest,
  type CommandResponse,
  type ErrorCode,
  type ObserveResponse,
} from "./types.ts";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fail = (msg: string): never => {
  throw new Error(`contract violation: ${msg}`);
};

export const isAction = (v: unknown): v is Action => ACTIONS.includes(v as Action);
export const isErrorCode = (v: unknown): v is ErrorCode => ERROR_CODES.includes(v as ErrorCode);

export function validateCapabilities(v: unknown): Capabilities {
  if (!isObj(v)) fail("capabilities is not an object");
  const c = v as Record<string, unknown>;
  if (c.contract_version !== CONTRACT_VERSION)
    fail(`contract_version ${String(c.contract_version)} != ${CONTRACT_VERSION}`);
  if (typeof c.bridge_version !== "string") fail("bridge_version missing");
  if (!Array.isArray(c.actions) || !c.actions.every(isAction)) fail("actions contains unknown action");
  if (!isObj(c.limits)) fail("limits missing");
  return v as unknown as Capabilities;
}

export function validateCommandRequest(v: unknown): CommandRequest {
  if (!isObj(v)) fail("request is not an object");
  const r = v as Record<string, unknown>;
  if (typeof r.request_id !== "string" || r.request_id.length === 0) fail("request_id missing");
  if (typeof r.workspace_id !== "string") fail("workspace_id missing");
  if (!isAction(r.action)) fail(`unknown action ${String(r.action)}`);
  if (!isObj(r.arguments)) fail("arguments missing");
  // Every mutating command must carry a request_id (already checked non-empty above).
  if (MUTATING_ACTIONS.includes(r.action as Action) && !r.request_id)
    fail(`mutating action ${r.action} needs a request_id`);
  return v as unknown as CommandRequest;
}

export function validateCommandResponse(v: unknown): CommandResponse {
  if (!isObj(v)) fail("response is not an object");
  const r = v as Record<string, unknown>;
  if (typeof r.request_id !== "string") fail("response request_id missing");
  switch (r.status) {
    case "accepted":
      break;
    case "result":
      if (!isObj(r.result)) fail("result payload missing");
      if ("counts" in (r.result as object)) validateBatchCounts((r.result as Record<string, unknown>).counts);
      break;
    case "error": {
      const e = r.error;
      if (!isObj(e) || !isErrorCode(e.code)) fail("error.code not a frozen error code");
      if (typeof (e as Record<string, unknown>).message !== "string") fail("error.message missing");
      break;
    }
    default:
      fail(`unknown status ${String(r.status)}`);
  }
  return v as unknown as CommandResponse;
}

function validateBatchCounts(v: unknown): void {
  if (!isObj(v)) fail("counts missing");
  const c = v as Record<string, number>;
  for (const k of ["requested", "started", "failed", "skipped"])
    if (typeof c[k] !== "number") fail(`counts.${k} missing`);
  if (c.started + c.failed + c.skipped !== c.requested)
    fail(`counts do not sum: ${c.started}+${c.failed}+${c.skipped} != ${c.requested}`);
}

export function validateObserveResponse(v: unknown): ObserveResponse {
  if (!isObj(v)) fail("observe response is not an object");
  const r = v as Record<string, unknown>;
  if (typeof r.workspace_id !== "string") fail("observe workspace_id missing");
  if (typeof r.latest_sequence !== "number") fail("latest_sequence missing");
  if (!Array.isArray(r.events)) fail("events missing");
  // Sequences are strictly increasing and never exceed latest_sequence.
  let prev = -Infinity;
  for (const ev of r.events as Record<string, unknown>[]) {
    if (typeof ev.sequence !== "number") fail("event.sequence missing");
    const seq = ev.sequence as number;
    if (seq <= prev) fail(`event sequence not increasing: ${seq} after ${prev}`);
    if (seq > (r.latest_sequence as number)) fail("event sequence exceeds latest_sequence");
    if (typeof ev.kind !== "string") fail("event.kind missing");
    if (!isObj(ev.payload)) fail("event.payload missing");
    prev = seq;
  }
  return v as unknown as ObserveResponse;
}
