#!/usr/bin/env node
// saple-bridge-control MCP server (PLAN.md Phase 2).
//
// Wraps the Phase 1 control endpoint as an MCP tool surface so any MCP client
// (Claude Code, June's own agent core later) can drive saple-bridge by tool
// call. Each tool maps one-to-one to a contract action and returns bridge's
// response verbatim - error codes and batch counts are never swallowed
// (PLAN.md Phase 2: "surface the contract's error codes and batch counts
// verbatim - no swallowing partial failures").

import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Action } from "../../src/contract/types.ts";
import { BridgeUnavailable, capabilities, command } from "./bridge.ts";

// June's logical workspace_id. Bridge spawns into whatever workspace is active;
// this id only scopes observe() routing, so a stable default is fine and any
// tool call may override it.
const DEFAULT_WORKSPACE = process.env.JUNE_WORKSPACE_ID ?? "june";

/** Wrap any contract value (result or error) as an MCP tool result. isError
 *  tracks the contract status so clients can branch without re-parsing. */
function toolResult(payload: unknown): CallToolResult {
  const isError =
    typeof payload === "object" && payload !== null && (payload as { status?: string }).status === "error";
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/** Send one command, passing bridge's response through untouched. Transport
 *  faults become a contract-shaped `bridge_unavailable` error so the client
 *  always sees a frozen error code, never a raw stack trace. */
async function send(
  action: Action,
  args: Record<string, unknown>,
  workspaceId: string,
  requestId: string,
): Promise<CallToolResult> {
  try {
    const resp = await command({ request_id: requestId, workspace_id: workspaceId, action, arguments: args });
    return toolResult(resp);
  } catch (e) {
    const code = e instanceof BridgeUnavailable ? e.code : "provider_failure";
    const message = e instanceof Error ? e.message : String(e);
    return toolResult({ status: "error", request_id: requestId, error: { code, message } });
  }
}

// Common fields on every tool. `workspace_id` scopes observe routing; on
// mutating tools `request_id` lets a client retry idempotently (bridge replays
// the original result) - omit it and each call is a fresh intent.
const workspaceArg = {
  workspace_id: z.string().optional().describe("June workspace id for observe routing (default: 'june')"),
};
const idempotencyArg = {
  request_id: z
    .string()
    .optional()
    .describe("Reuse across retries to make this call idempotent; omit for a new unique intent"),
};

const server = new McpServer({ name: "saple-bridge-control", version: "0.1.0" });

server.registerTool(
  "spawn_agents",
  {
    title: "Spawn agents",
    description:
      "Batch-spawn coding agents into the open saple-bridge workspace. Returns batch counts (requested/started/failed/skipped) and the new agent ids; partial success is reported, not thrown.",
    inputSchema: {
      provider: z.string().default("claude").describe("Agent provider, e.g. 'claude' or 'codex'"),
      model: z.string().optional().describe("Model id, e.g. 'claude-opus-4-8'"),
      count: z.number().int().min(1).default(1).describe("How many agents to spawn"),
      prompt: z.string().optional().describe("Initial task typed into each agent on spawn"),
      ...workspaceArg,
      ...idempotencyArg,
    },
  },
  ({ provider, model, count, prompt, workspace_id, request_id }) =>
    send(
      "spawn_agents",
      { provider, model, count, prompt },
      workspace_id ?? DEFAULT_WORKSPACE,
      request_id ?? randomUUID(),
    ),
);

server.registerTool(
  "assign_task",
  {
    title: "Assign task",
    description: "Give an existing agent a task by writing it to that agent's terminal.",
    inputSchema: {
      agent_id: z.string().describe("Stable id of the target agent (from spawn_agents or get_swarm_status)"),
      task: z.string().describe("The task text to send to the agent"),
      ...workspaceArg,
      ...idempotencyArg,
    },
  },
  ({ agent_id, task, workspace_id, request_id }) =>
    send("assign_task", { agent_id, task }, workspace_id ?? DEFAULT_WORKSPACE, request_id ?? randomUUID()),
);

server.registerTool(
  "send_to_terminal",
  {
    title: "Send to terminal",
    description: "Write raw text to a bridge terminal pane (no trailing newline is added).",
    inputSchema: {
      pane_id: z.string().describe("Id of the terminal pane to write to"),
      data: z.string().describe("Text to write verbatim to the pane"),
      ...workspaceArg,
      ...idempotencyArg,
    },
  },
  ({ pane_id, data, workspace_id, request_id }) =>
    send("write_terminal", { pane_id, data }, workspace_id ?? DEFAULT_WORKSPACE, request_id ?? randomUUID()),
);

server.registerTool(
  "close_terminal",
  {
    title: "Close terminal",
    description: "Close a bridge terminal pane by id.",
    inputSchema: {
      pane_id: z.string().describe("Id of the terminal pane to close"),
      ...workspaceArg,
      ...idempotencyArg,
    },
  },
  ({ pane_id, workspace_id, request_id }) =>
    send("close_terminal", { pane_id }, workspace_id ?? DEFAULT_WORKSPACE, request_id ?? randomUUID()),
);

server.registerTool(
  "open_browser",
  {
    title: "Open browser",
    description: "Open (or navigate) the bridge browser panel to a url.",
    inputSchema: {
      url: z.string().describe("URL to open"),
      ...workspaceArg,
      ...idempotencyArg,
    },
  },
  ({ url, workspace_id, request_id }) =>
    send("open_browser", { url }, workspace_id ?? DEFAULT_WORKSPACE, request_id ?? randomUUID()),
);

server.registerTool(
  "get_swarm_status",
  {
    title: "Get swarm status",
    description: "Read the current roster: open terminals and active agents. Non-mutating.",
    inputSchema: { ...workspaceArg },
  },
  ({ workspace_id }) =>
    // Non-mutating: bridge does not dedupe it, but a correlation id is still required.
    send("get_swarm_status", {}, workspace_id ?? DEFAULT_WORKSPACE, randomUUID()),
);

async function main(): Promise<void> {
  // Fail fast with a clear message if the SDK/transport can't start. A dead
  // bridge is NOT a startup error - tools report it per-call as bridge_unavailable.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // One-line proof-of-life on stderr (stdout is the JSON-RPC channel - never log there).
  process.stderr.write("[saple-bridge-control] MCP server ready on stdio\n");
}

// Expose the capabilities probe for diagnostics without starting the server.
export { capabilities };

main().catch((e) => {
  process.stderr.write(`[saple-bridge-control] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
