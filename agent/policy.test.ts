// The gate policy is the load-bearing safety check (PLAN.md §5, Phase 3 exit:
// "an approval gate cannot be bypassed"). These pin which actions demand a human
// yes and that the confirmation text carries the exact count.

import { describe, expect, it } from "vitest";

import { actionOf, classify, isGated, summarize } from "./policy.ts";

describe("gate policy", () => {
  it("recovers the bare action from an MCP tool name", () => {
    expect(actionOf("mcp__saple-bridge-control__spawn_agents")).toBe("spawn_agents");
    expect(actionOf("get_swarm_status")).toBe("get_swarm_status");
  });

  it("gates the expensive and destructive actions, and nothing safe", () => {
    expect(isGated(classify("spawn_agents"))).toBe(true); // expensive: paid launch
    expect(isGated(classify("close_terminal"))).toBe(true); // destructive
    expect(isGated(classify("get_swarm_status"))).toBe(false); // observe
    expect(isGated(classify("open_browser"))).toBe(false); // reversible
    expect(isGated(classify("assign_task"))).toBe(false); // reversible
    expect(isGated(classify("send_to_terminal"))).toBe(false); // reversible
  });

  it("states the exact count and cost/network class in a spawn confirmation (§5, Phase 7)", () => {
    expect(summarize("spawn_agents", { provider: "codex", count: 4 })).toBe("Spawn 4 codex agents (paid, uses network)");
    expect(summarize("spawn_agents", { provider: "claude", count: 1 })).toBe("Spawn 1 claude agent (paid, uses network)");
  });

  it("gates a file write but not a file read (Phase 9 §5 external effect)", () => {
    expect(isGated(classify("write_file"))).toBe(true); // overwrites a file - confirm
    expect(isGated(classify("read_file"))).toBe(false); // observe
    expect(isGated(classify("list_files"))).toBe(false); // observe
    expect(summarize("write_file", { path: "notes/todo.md" })).toBe("Write file notes/todo.md");
  });

  it("an unknown action defaults to reversible, never silently gated off", () => {
    expect(classify("some_future_action")).toBe("reversible");
    expect(summarize("some_future_action", {})).toBe("Run some_future_action");
  });
});
