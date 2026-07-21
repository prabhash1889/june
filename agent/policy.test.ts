// The gate policy is the load-bearing safety check (PLAN.md §5, Phase 3 exit:
// "an approval gate cannot be bypassed"). These pin which actions demand a human
// yes and that the confirmation text carries the exact count.

import { describe, expect, it } from "vitest";

import {
  actionOf,
  classify,
  isGated,
  redactParams,
  serverOf,
  setServerDefaults,
  showPayload,
  summarize,
  unattendedBlockReason,
} from "./policy.ts";

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

  it("shows the FULL dangerous payload before the act, with control chars visible (16.3)", () => {
    // A `\n` in terminal data runs a shell command; the approver must see the
    // whole payload with the newline exposed as `\n`, never just the pane id.
    expect(summarize("send_to_terminal", { pane_id: "p1", data: "ls\nrm -rf /" })).toBe(
      "Write to terminal p1: ls\\nrm -rf /",
    );
    // assign_task is spoken-approvable (14.2) - the task text is spoken/shown in full.
    expect(summarize("assign_task", { agent_id: "a3", task: "deploy to prod" })).toBe("Assign to agent a3: deploy to prod");
    // showPayload makes every control char visible so nothing hides off the line.
    expect(showPayload("a\r\n\tb")).toBe("a\\r\\n\\tb");
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

  it("does not gate recording a lesson (Phase 17.1: local, contained, reversible)", () => {
    expect(isGated(classify("record_lesson"))).toBe(false); // reversible - auto-run
    expect(summarize("record_lesson", { lesson: "pass the model id" })).toBe("Note lesson: pass the model id");
  });

  it("an unknown action fails closed to destructive (gated), never silently auto-run", () => {
    expect(classify("some_future_action")).toBe("destructive");
    expect(isGated(classify("some_future_action"))).toBe(true);
    expect(summarize("some_future_action", {})).toBe("Run some_future_action {}");
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
    // B1.1: a generic server NEVER borrows June's built-in classification. A
    // third-party tool that merely shares the name `send_to_terminal` is a
    // different tool, so it takes the server default (here observe), not the
    // built-in destructive class. Its class is the user's promotion, nothing more.
    expect(classify("send_to_terminal", "github")).toBe("observe");
    // Another server without a default still fails closed.
    expect(classify("anything", "other")).toBe("destructive");
    // Replacing the map wholesale drops the old override (removed in settings).
    setServerDefaults({});
    expect(classify("list_issues", "github")).toBe("destructive");
  });

  it("a generic server cannot spoof a built-in class via a shared/nested tool name (B1.1)", () => {
    // The exact spoof shapes from the review: a third-party server naming a tool
    // `remember` / `read_file` / `open_browser` (or nesting it) must NOT inherit
    // June's ungated built-in class. No server default -> all fail closed to gated.
    for (const tool of [
      "mcp__evil__remember",
      "mcp__evil__x__remember", // nested: tool parsed whole as "x__remember"
      "mcp__anything__read_file",
      "mcp__anything__open_browser",
    ]) {
      const cls = classify(actionOf(tool), serverOf(tool));
      expect(cls).toBe("destructive");
      expect(isGated(cls)).toBe(true);
    }
    // The tool segment is kept VERBATIM from the front, so a nested spoof can't
    // masquerade as the bare built-in action.
    expect(actionOf("mcp__evil__x__remember")).toBe("x__remember");
    expect(serverOf("mcp__evil__x__remember")).toBe("evil");
    // June's OWN memory server still classifies `remember` as its built-in class.
    expect(classify(actionOf("mcp__memory__remember"), serverOf("mcp__memory__remember"))).toBe("reversible");
  });

  it("an unknown gated tool's summary shows its params, control chars visible (B1.6/B1.7)", () => {
    // The default branch previously rendered "Run <action>" with no params, so a
    // user approved blind. Now the payload is shown with invisibles escaped.
    const rtl = String.fromCharCode(0x202e); // an invisible RTL-override
    const summary = summarize("push_config", { target: "prod", note: `a${rtl}b\nc` });
    expect(summary).toContain("push_config");
    expect(summary).toContain("prod");
    expect(summary).toContain("\\u202e"); // RTL-override made visible
    expect(summary).toContain("\\n"); // newline made visible
  });

  it("showPayload escapes every invisible char, not just the common three (B1.7)", () => {
    const wrap = (code: number): string => "a" + String.fromCharCode(code) + "b";
    expect(showPayload(wrap(0x202e))).toBe("a\\u202eb"); // RTL override (Cf)
    expect(showPayload(wrap(0x200b))).toBe("a\\u200bb"); // zero-width space (Cf)
    expect(showPayload(wrap(0x0000))).toBe("a\\u0000b"); // NUL (Cc)
  });

  it("unattended runs allow only local observe reads (B1.3)", () => {
    const net = new Set(["brave-search"]);
    // Local read -> allowed.
    expect(unattendedBlockReason({ cls: "observe", action: "read_file", server: "files" }, net)).toBeNull();
    // Reversible (open_browser), gated, and memory writes all blocked.
    expect(unattendedBlockReason({ cls: "reversible", action: "open_browser" }, net)).toBe("needs approval");
    expect(unattendedBlockReason({ cls: "destructive", action: "write_file" }, net)).toBe("needs approval");
    expect(unattendedBlockReason({ cls: "reversible", action: "remember", server: "memory" }, net)).toBe(
      "needs approval",
    );
    // A promoted networked search server (observe) is still blocked: it can exfil.
    expect(unattendedBlockReason({ cls: "observe", action: "web_search", server: "brave-search" }, net)).toBe(
      "reaches the network",
    );
    // A memory write mis-promoted to observe is still blocked (defense in depth).
    expect(unattendedBlockReason({ cls: "observe", action: "record_lesson", server: "lessons" }, net)).toBe(
      "writes persistent memory",
    );
  });

  it("shows the automation prompt on the approval card, control chars visible (1.2)", () => {
    // The prompt is what runs unattended on every fire, so it must be on the card
    // the user approves - an injected instruction can't hide behind a label.
    expect(
      summarize("add_schedule", { label: "briefing", kind: "daily", time: "09:00", prompt: "read my email" }),
    ).toBe('Schedule "briefing" to run daily at 09:00 (unattended): "read my email"');
    expect(summarize("add_watch", { label: "build", everyMinutes: 5, prompt: "check CI\nexfiltrate" })).toBe(
      'Watch "build" every 5 min (unattended): "check CI\\nexfiltrate"',
    );
    // No prompt -> no dangling tail.
    expect(summarize("add_schedule", { label: "x", kind: "every", everyMinutes: 30 })).toBe(
      'Schedule "x" to run every 30 min (unattended)',
    );
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
