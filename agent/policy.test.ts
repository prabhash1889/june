// The gate policy is the load-bearing safety check (PLAN.md §5, Phase 3 exit:
// "an approval gate cannot be bypassed"). These pin which actions demand a human
// yes and that the confirmation text carries the exact count.

import { describe, expect, it } from "vitest";

import { actionOf, classify, isGated, redactParams, serverOf, setServerDefaults, summarize } from "./policy.ts";

describe("gate policy", () => {
  it("recovers the bare action from an MCP tool name", () => {
    expect(actionOf("mcp__saple-bridge-control__spawn_agents")).toBe("spawn_agents");
    expect(actionOf("get_swarm_status")).toBe("get_swarm_status");
  });

  it("recovers the server segment from an MCP tool name", () => {
    expect(serverOf("mcp__saple-bridge-control__spawn_agents")).toBe("saple-bridge-control");
    expect(serverOf("mcp__files__read_file")).toBe("files");
    expect(serverOf("get_swarm_status")).toBeUndefined();
  });

  it("gates the expensive and destructive actions, and nothing safe", () => {
    expect(isGated(classify("spawn_agents"))).toBe(true); // expensive: paid launch
    expect(isGated(classify("close_terminal"))).toBe(true); // destructive
    expect(isGated(classify("get_swarm_status"))).toBe(false); // observe
    expect(isGated(classify("open_browser"))).toBe(false); // reversible
    // 10.1 raised these from reversible to gated: assign_task spends money, and a
    // newline in send_to_terminal's data executes shell commands in the pane.
    expect(isGated(classify("assign_task"))).toBe(true); // expensive
    expect(isGated(classify("send_to_terminal"))).toBe(true); // destructive
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

  it("does not gate remembering a fact (Phase 11.4: local, contained, reversible)", () => {
    expect(isGated(classify("remember"))).toBe(false); // reversible - auto-run
    expect(summarize("remember", { fact: "prefers Codex agents" })).toBe("Remember: prefers Codex agents");
  });

  it("an unknown action fails closed to destructive (gated), never silently auto-run", () => {
    expect(classify("some_future_action")).toBe("destructive");
    expect(isGated(classify("some_future_action"))).toBe(true);
    expect(summarize("some_future_action", {})).toBe("Run some_future_action");
  });

  it("a server default classifies its otherwise-unknown tools, still fail-closed without one", () => {
    // No server default registered -> unknown tool on a known server is still gated.
    expect(classify("some_new_tool", "saple-bridge-control")).toBe("destructive");
  });

  it("setServerDefaults promotes a server's unknown tools, and clears when reset (Phase 13.2)", () => {
    // A user who inspected a read-only server promotes it to observe.
    setServerDefaults({ github: "observe" });
    expect(classify("list_issues", "github")).toBe("observe");
    expect(isGated(classify("list_issues", "github"))).toBe(false);
    // A named action still wins over the server default.
    expect(classify("send_to_terminal", "github")).toBe("destructive");
    // Another server without a default still fails closed.
    expect(classify("anything", "other")).toBe("destructive");
    // Replacing the map wholesale drops the old override (removed in settings).
    setServerDefaults({});
    expect(classify("list_issues", "github")).toBe("destructive");
  });

  it("redacts string params under on-device privacy modes but keeps them under standard", () => {
    const params = { path: "notes/secret.md", count: 3, force: true };
    expect(redactParams(params, "standard")).toEqual(params);
    expect(redactParams(params, undefined)).toEqual(params);
    // On-device modes hide string content (paths, commands, dictation) but keep
    // numbers/booleans so the audit record stays useful.
    expect(redactParams(params, "strict-offline")).toEqual({
      path: "[redacted 15 chars]",
      count: 3,
      force: true,
    });
  });
});
