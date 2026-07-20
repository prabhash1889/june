import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./settings.ts";
import {
  activeTask,
  coerceMission,
  decomposePrompt,
  type Mission,
  missionProgress,
  parseTaskList,
  parseToolsets,
} from "./missions.ts";

// The board reducer, verify -> retry loop, and orchestration moved to Rust
// (src-tauri/src/missions.rs, improvement-5 P2 5.2) and are unit-tested there.
// What stays here is the webview's share: the decomposition prompt + parsers and
// the display-side coercion.

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

  it("falls back to non-empty lines when there are no markers, skipping TOOLS:", () => {
    expect(parseTaskList("TOOLS: files\ndo a\n\ndo b\n")).toEqual(["do a", "do b"]);
  });

  it("caps a runaway decomposition", () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i}`).join("\n");
    expect(parseTaskList(many)).toHaveLength(12);
  });
});

describe("decomposePrompt (5.3)", () => {
  it("asks for a numbered list and names the outcome", () => {
    const p = decomposePrompt("ship the release");
    expect(p).toContain("numbered list");
    expect(p).toContain("ship the release");
    expect(p).not.toContain("TOOLS:");
  });

  it("asks for a TOOLS: line only when the user has capability servers (5.4)", () => {
    const p = decomposePrompt("triage the bug", ["github", "files"]);
    expect(p).toContain("TOOLS:");
    expect(p).toContain("github, files");
  });
});

describe("parseToolsets (5.4)", () => {
  const known = ["github", "files", "search"];

  it("keeps only the ids the user actually has, deduplicated", () => {
    expect(parseToolsets("TOOLS: github, files, github, aliens\n1. do a", known)).toEqual(["github", "files"]);
  });

  it("reads 'all' / absence / garbage as no restriction", () => {
    expect(parseToolsets("TOOLS: all\n1. do a", known)).toEqual([]);
    expect(parseToolsets("1. do a\n2. do b", known)).toEqual([]);
    expect(parseToolsets("TOOLS:\n1. do a", known)).toEqual([]);
  });

  it("is case-tolerant on the marker line", () => {
    expect(parseToolsets("tools: Files\n1. x", known)).toEqual(["files"]);
  });
});

describe("board views (activeTask / missionProgress)", () => {
  const mission: Mission = {
    id: "m",
    outcome: "do it",
    status: "active",
    toolsetIds: [],
    tasks: [
      { id: "t0", title: "a", status: "done" },
      { id: "t1", title: "b", status: "active" },
      { id: "t2", title: "c", status: "failed" },
      { id: "t3", title: "d", status: "pending" },
    ],
  };

  it("finds the task being worked", () => {
    expect(activeTask(mission)!.title).toBe("b");
  });

  it("counts the board for the compact readout", () => {
    expect(missionProgress(mission)).toEqual({ done: 1, failed: 1, total: 4 });
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

  it("accepts the Rust runner's board (extra fields like verify ignored)", () => {
    const rust = {
      id: "m",
      outcome: "o",
      status: "active",
      toolsetIds: [],
      verify: true,
      tasks: [{ id: "t0", title: "a", status: "active" }],
    };
    expect(coerceMission(rust)!.tasks[0].status).toBe("active");
  });
});

describe("19.3: zero saple-* dependency to run", () => {
  it("ships with no MCP servers required (saple is opt-in catalog only)", () => {
    // A fresh install has an empty server list - June works standalone with no
    // saple (or any) MCP server added. saple-bridge/saple-memory are opt-in.
    expect(DEFAULT_SETTINGS.mcpServers).toEqual([]);
  });
});
