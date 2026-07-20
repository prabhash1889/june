import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./settings.ts";
import { type McpServerEntry } from "./mcp-servers.ts";
import {
  activeTask,
  advanceMission,
  coerceMission,
  missionProgress,
  newMission,
  parseTaskList,
  parseVerdict,
  relevantServers,
  retryPrompt,
  stopMission,
  verifyPrompt,
} from "./missions.ts";

describe("parseTaskList", () => {
  it("parses a numbered list, stripping markers and emphasis", () => {
    expect(parseTaskList("Here is the plan:\n1. **Open the repo**\n2. Run the tests\n3) Report results")).toEqual([
      "Open the repo",
      "Run the tests",
      "Report results",
    ]);
  });

  it("parses bulleted lists (-, *, •)", () => {
    expect(parseTaskList("- first\n* second\n• third")).toEqual(["first", "second", "third"]);
  });

  it("ignores prose around a marked list (the intro line is not a task)", () => {
    expect(parseTaskList("Sure, here are the steps.\n1. do a\n2. do b")).toEqual(["do a", "do b"]);
  });

  it("falls back to non-empty lines when there are no markers", () => {
    expect(parseTaskList("do a\n\ndo b\n")).toEqual(["do a", "do b"]);
  });

  it("caps a runaway decomposition", () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i}`).join("\n");
    expect(parseTaskList(many)).toHaveLength(12);
  });
});

describe("newMission", () => {
  it("builds a board with the first task active", () => {
    const m = newMission("ship the feature", ["design it", "build it", "test it"]);
    expect(m).not.toBeNull();
    expect(m!.status).toBe("active");
    expect(m!.tasks.map((t) => t.status)).toEqual(["active", "pending", "pending"]);
    expect(activeTask(m!)!.title).toBe("design it");
  });

  it("returns null when there is nothing to work", () => {
    expect(newMission("x", [])).toBeNull();
    expect(newMission("x", ["  "])).toBeNull();
  });
});

describe("advanceMission", () => {
  it("walks tasks to a done mission on all-success", () => {
    let m = newMission("do it", ["a", "b"])!;
    m = advanceMission(m, true);
    expect(m.status).toBe("active");
    expect(activeTask(m)!.title).toBe("b");
    m = advanceMission(m, true);
    expect(m.status).toBe("done");
    expect(activeTask(m)).toBeNull();
    expect(missionProgress(m)).toEqual({ done: 2, failed: 0, total: 2 });
  });

  it("finishes failed if any task failed, but still works the remaining tasks", () => {
    let m = newMission("do it", ["a", "b"])!;
    m = advanceMission(m, false); // a failed
    expect(m.status).toBe("active"); // keeps going
    expect(activeTask(m)!.title).toBe("b");
    m = advanceMission(m, true); // b done, but a failed earlier
    expect(m.status).toBe("failed");
    expect(missionProgress(m)).toEqual({ done: 1, failed: 1, total: 2 });
  });

  it("is a no-op once the mission has finished", () => {
    let m = newMission("do it", ["a"])!;
    m = advanceMission(m, true);
    expect(m.status).toBe("done");
    expect(advanceMission(m, true)).toEqual(m);
  });
});

describe("stopMission (B3.5)", () => {
  it("fails the active task and closes the mission so Clear can render", () => {
    let m = newMission("do it", ["a", "b", "c"])!;
    m = advanceMission(m, true); // a done, b active
    const stopped = stopMission(m);
    expect(stopped.status).toBe("failed");
    expect(stopped.tasks.map((t) => t.status)).toEqual(["done", "failed", "pending"]);
  });

  it("is a no-op once the mission has already finished", () => {
    let m = newMission("do it", ["a"])!;
    m = advanceMission(m, true); // done, nothing active
    expect(stopMission(m)).toEqual(m);
  });
});

describe("advanceMission notes (P1.4)", () => {
  it("records a failure reason on the failed task, none on success", () => {
    let m = newMission("do it", ["a", "b"])!;
    m = advanceMission(m, false, "the file was not written");
    expect(m.tasks[0].note).toBe("the file was not written");
    m = advanceMission(m, true, "ignored on success");
    expect(m.tasks[1].note).toBeUndefined();
  });
});

describe("parseVerdict (P1.4)", () => {
  it("reads an explicit PASS/FAIL on the first line", () => {
    expect(parseVerdict("PASS\nThe tests all ran green.").pass).toBe(true);
    const fail = parseVerdict("FAIL - the changelog was not updated.");
    expect(fail.pass).toBe(false);
    expect(fail.reason).toContain("changelog");
  });

  it("fails conservatively on an ambiguous or errored verdict", () => {
    expect(parseVerdict("I could not tell if it worked.").pass).toBe(false);
    expect(parseVerdict("It both passed and failed in parts.").pass).toBe(false); // mentions FAIL
    expect(parseVerdict("").pass).toBe(false);
  });

  it("treats an unqualified pass mention as pass", () => {
    expect(parseVerdict("Everything looks good, this is a PASS.").pass).toBe(true);
  });
});

describe("verify/retry prompt builders (P1.4)", () => {
  it("verifyPrompt names the outcome and asks for PASS/FAIL", () => {
    const p = verifyPrompt("ship the release", "run the tests");
    expect(p).toContain("ship the release");
    expect(p).toContain("run the tests");
    expect(p).toMatch(/PASS or FAIL/);
  });

  it("retryPrompt folds in the failure reason", () => {
    expect(retryPrompt("run the tests", "two tests errored")).toContain("two tests errored");
    // No reason still produces a usable retry.
    expect(retryPrompt("run the tests", "")).toContain("Try again");
  });
});

describe("relevantServers (19.2 composable toolsets)", () => {
  const entries: McpServerEntry[] = [
    { id: "github", label: "GitHub", enabled: true, offlineSafe: false, transport: { kind: "stdio", command: "x", args: [], env: {} } },
    { id: "files", label: "Files", enabled: true, offlineSafe: true, transport: { kind: "stdio", command: "y", args: [], env: {} } },
  ];

  it("keeps only the named servers", () => {
    expect(relevantServers(entries, ["files"]).map((e) => e.id)).toEqual(["files"]);
  });

  it("an empty toolset means no restriction (every enabled server)", () => {
    expect(relevantServers(entries, [])).toEqual(entries);
  });
});

describe("coerceMission", () => {
  it("round-trips a valid mission and drops bad tasks", () => {
    const raw = {
      id: "m",
      outcome: "do it",
      status: "active",
      toolsetIds: ["github", 5],
      tasks: [{ id: "t0", title: "a", status: "done" }, { title: "" }, "junk", { title: "b", status: "weird" }],
    };
    const m = coerceMission(raw)!;
    expect(m.tasks.map((t) => t.title)).toEqual(["a", "b"]);
    expect(m.tasks[1].status).toBe("pending"); // unknown status coerced
    expect(m.toolsetIds).toEqual(["github"]); // non-string dropped
  });

  it("returns null for absent / empty / malformed input", () => {
    expect(coerceMission(null)).toBeNull();
    expect(coerceMission({ outcome: "x" })).toBeNull(); // no tasks
    expect(coerceMission({ tasks: [{ title: "" }] })).toBeNull(); // no usable task
  });
});

describe("19.3: zero saple-* dependency to run", () => {
  it("ships with no MCP servers required (saple is opt-in catalog only)", () => {
    // A fresh install has an empty server list - June works standalone with no
    // saple (or any) MCP server added. saple-bridge/saple-memory are opt-in.
    expect(DEFAULT_SETTINGS.mcpServers).toEqual([]);
  });

  it("a mission runs with no toolset (no saple server needed)", () => {
    const m = newMission("summarize my notes", ["read the notes", "write a summary"])!;
    expect(relevantServers([], m.toolsetIds)).toEqual([]);
  });
});
