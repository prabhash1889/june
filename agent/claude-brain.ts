// The Claude brain (PLAN.md §3: "Claude gets the deepest integration - Agent
// SDK niceties like permission hooks"). Wraps @anthropic-ai/claude-agent-sdk's
// query() as one implementation of the provider-neutral Brain interface.
//
// Two SDK features carry the phase:
//   - mcpServers: attaches Phase 2's saple-bridge-control tool surface.
//   - canUseTool: the permission hook we route June's execution-layer approval
//     gate through, so the brain physically cannot run a gated tool without a
//     human yes (Phase 3 exit criterion). The gate is supplied per-turn by the
//     orchestrator, not baked in here - that is what makes it provider-neutral.

import { query, type McpServerConfig, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { type Brain, type TurnHooks, type TurnResult } from "./brain.ts";
import { actionOf, classify, serverOf, summarize } from "./policy.ts";

export interface ClaudeBrainConfig {
  model?: string;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string; // tool_use block id
  tool_use_id?: string; // tool_result -> the tool_use it answers
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

export class ClaudeBrain implements Brain {
  readonly id = "claude";
  readonly model: string;
  #systemPrompt: string;
  #mcpServers: Record<string, McpServerConfig>;

  constructor(cfg: ClaudeBrainConfig) {
    this.model = cfg.model ?? "claude-opus-4-8";
    this.#systemPrompt = cfg.systemPrompt;
    this.#mcpServers = cfg.mcpServers;
  }

  async run(prompt: string, hooks: TurnHooks): Promise<TurnResult> {
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const action = actionOf(toolName);
      const cls = classify(action, serverOf(toolName));
      const decision = await hooks.gate({
        tool: toolName,
        action,
        cls,
        input,
        summary: summarize(action, input),
      });
      return decision.allow
        ? { behavior: "allow", updatedInput: decision.input ?? input }
        : { behavior: "deny", message: decision.reason };
    };

    const response = query({
      prompt,
      options: {
        model: this.model,
        systemPrompt: this.#systemPrompt,
        mcpServers: this.#mcpServers,
        canUseTool,
        // June's agent has NO built-in tools (no Bash/Read/Edit) and ignores the
        // developer's own Claude Code settings - it may only touch the workspace
        // through the attached MCP servers.
        tools: [],
        settingSources: [],
        permissionMode: "default",
      },
    });

    let finalText = "";
    let isError = false;
    // Correlate a tool_result back to the tool_use it answers: results arrive on a
    // later synthetic user turn carrying only `tool_use_id`, so without this map
    // every result reported as an empty action and batch counts (spawn_agents)
    // never rendered on the default brain (10.4).
    const actionById = new Map<string, string>();

    for await (const msg of response) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content as ContentBlock[]) {
          if (block.type === "text" && block.text) hooks.onText?.(block.text);
          else if (block.type === "tool_use") {
            const action = actionOf(block.name ?? "");
            if (block.id) actionById.set(block.id, action);
            hooks.onToolUse?.({ tool: block.name ?? "", action, input: block.input ?? {} });
          }
        }
      } else if (msg.type === "user" && hooks.onToolResult) {
        // Tool results ride back on a synthetic user turn.
        const content = msg.message.content;
        if (Array.isArray(content))
          for (const block of content as ContentBlock[])
            if (block.type === "tool_result")
              hooks.onToolResult(
                (block.tool_use_id && actionById.get(block.tool_use_id)) || "",
                block.content,
                block.is_error === true,
              );
      } else if (msg.type === "result") {
        isError = msg.subtype !== "success";
        finalText = msg.subtype === "success" ? msg.result : `June hit an error: ${msg.subtype}`;
      }
    }

    return { text: finalText, isError };
  }
}
