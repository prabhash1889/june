// The agent core (PLAN.md §3, Phase 3). Assembles a Brain with its capabilities
// (MCP servers) and the voice-tuned prompt, and hands callers a single `run`.
// The orchestrator owns the capability list and the approval gate; the brain is
// swappable underneath. saple-bridge-control is the one committed capability -
// saple-memory / artemis attach later as extra config entries, never new code.

import { fileURLToPath } from "node:url";

import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { type Brain, type TurnHooks, type TurnResult } from "./brain.ts";
import { ClaudeBrain } from "./claude-brain.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

/** Absolute path to Phase 2's MCP server, resolved from this file so it works
 *  wherever June is launched from. */
function bridgeControlServerPath(): string {
  return fileURLToPath(new URL("../mcp/saple-bridge-control/server.ts", import.meta.url));
}

/** The committed capability: the saple-bridge-control MCP server, run with tsx. */
export function defaultMcpServers(workspaceId?: string): Record<string, McpServerConfig> {
  return {
    "saple-bridge-control": {
      command: "npx",
      args: ["tsx", bridgeControlServerPath()],
      // Keep the tools in the prompt instead of deferred behind tool-search:
      // with no built-in tools the model has no search tool to discover them,
      // so without this it hallucinates tool names instead of calling ours.
      alwaysLoad: true,
      ...(workspaceId ? { env: { ...process.env, JUNE_WORKSPACE_ID: workspaceId } } : {}),
    },
  };
}

export interface JuneAgentOptions {
  model?: string;
  workspaceId?: string;
  /** Extra MCP capabilities merged over the default (e.g. saple-memory). */
  extraMcpServers?: Record<string, McpServerConfig>;
}

export interface JuneAgent {
  brain: Brain;
  run(prompt: string, hooks: TurnHooks): Promise<TurnResult>;
}

export function createJuneAgent(opts: JuneAgentOptions = {}): JuneAgent {
  const brain = new ClaudeBrain({
    model: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { ...defaultMcpServers(opts.workspaceId), ...opts.extraMcpServers },
  });
  return { brain, run: (prompt, hooks) => brain.run(prompt, hooks) };
}
