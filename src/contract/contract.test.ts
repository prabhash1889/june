// Contract tests: freeze the June <-> bridge control contract. These pass
// without starting bridge (PLAN.md §6, Phase 1) - they validate the golden JSON
// examples against the runtime validators and the frozen enums.

import { expect, it, describe } from "vitest";

import capabilities from "./examples/capabilities.json";
import commandSuccess from "./examples/command-success.json";
import commandRejected from "./examples/command-rejected.json";
import observe from "./examples/observe.json";
import { ACTIONS, ERROR_CODES, MUTATING_ACTIONS } from "./types.ts";
import {
  validateCapabilities,
  validateCommandRequest,
  validateCommandResponse,
  validateObserveResponse,
} from "./validate.ts";

describe("golden examples conform to the contract", () => {
  it("capabilities()", () => {
    const c = validateCapabilities(capabilities);
    expect(c.actions).toEqual([...ACTIONS]);
  });

  it("read_terminal is a non-mutating observe action (4.9)", () => {
    // A terminal read carries no request_id dedupe - it must be in ACTIONS but NOT
    // MUTATING_ACTIONS, so it validates without a request_id like get_swarm_status.
    expect(ACTIONS).toContain("read_terminal");
    expect(MUTATING_ACTIONS).not.toContain("read_terminal");
    validateCommandRequest({ request_id: "corr-1", workspace_id: "w", action: "read_terminal", arguments: { pane_id: "p3" } });
  });

  it("a successful command carries batch counts that sum", () => {
    validateCommandRequest(commandSuccess.request);
    const res = validateCommandResponse(commandSuccess.response);
    expect(res.status).toBe("result");
    if (res.status === "result") expect(res.result.counts?.requested).toBe(5);
  });

  it("a rejected command carries a frozen error code and echoes request_id", () => {
    validateCommandRequest(commandRejected.request);
    const res = validateCommandResponse(commandRejected.response);
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(ERROR_CODES).toContain(res.error.code);
      expect(res.request_id).toBe(commandRejected.request.request_id);
    }
  });

  it("observe() events are strictly ordered and within latest_sequence", () => {
    const r = validateObserveResponse(observe.response);
    expect(r.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(r.latest_sequence).toBe(3);
  });
});

describe("the validators reject contract violations", () => {
  it("rejects an unknown error code", () => {
    expect(() =>
      validateCommandResponse({ status: "error", request_id: "x", error: { code: "boom", message: "" } }),
    ).toThrow(/frozen error code/);
  });

  it("rejects batch counts that do not sum", () => {
    expect(() =>
      validateCommandResponse({
        status: "result",
        request_id: "x",
        result: { counts: { requested: 5, started: 2, failed: 1, skipped: 1 } },
      }),
    ).toThrow(/do not sum/);
  });

  it("rejects out-of-order event sequences", () => {
    expect(() =>
      validateObserveResponse({
        workspace_id: "w",
        latest_sequence: 2,
        events: [
          { sequence: 2, workspace_id: "w", kind: "a", payload: {} },
          { sequence: 1, workspace_id: "w", kind: "b", payload: {} },
        ],
      }),
    ).toThrow(/not increasing/);
  });

  it("rejects a mutating command with no request_id", () => {
    expect(() =>
      validateCommandRequest({ request_id: "", workspace_id: "w", action: "spawn_agents", arguments: {} }),
    ).toThrow(/request_id missing/);
  });
});
