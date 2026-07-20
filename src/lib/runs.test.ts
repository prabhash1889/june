import { describe, expect, it } from "vitest";

import { coerceRun, coerceRuns } from "./runs.ts";

describe("coerceRuns (P1.3)", () => {
  it("keeps valid records and defaults missing fields", () => {
    const out = coerceRuns([
      { id: 5, source: "schedule: Briefing", prompt: "brief me", started: "2026-07-20T09:00:00", ended: "2026-07-20T09:00:04", reply: "Done.", isError: false, blocked: [] },
      { source: "watch: Build", reply: "Still building.", blocked: ["Open browser at http://x"] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(5);
    expect(out[1]).toMatchObject({ id: 0, source: "watch: Build", isError: false, blocked: ["Open browser at http://x"] });
  });

  it("drops noise and non-string blocked entries", () => {
    const out = coerceRuns([null, "junk", { id: 1 }, { source: "x", blocked: ["ok", 3, null] }]);
    // {id:1} has neither source nor reply -> dropped; the last keeps only the string blocked entry.
    expect(out).toHaveLength(1);
    expect(out[0].blocked).toEqual(["ok"]);
  });

  it("returns [] for a non-array", () => {
    expect(coerceRuns("nope")).toEqual([]);
    expect(coerceRun(42)).toBeNull();
  });
});
