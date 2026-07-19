// The Brain interface (PLAN.md §3) - one provider-neutral seam over the agent
// loop. June runs ONE tool-calling loop; each brain (Claude now, GPT/Gemini/
// local later) implements this same interface, so adding a provider is a config
// entry, not a new loop. Claude gets the deepest integration (Agent SDK), but
// the orchestrator (agent/core.ts) only ever sees `Brain`, and - crucially -
// the approval `gate` is passed in by the orchestrator, so it holds regardless
// of which brain is plugged in (PLAN.md §5, Phase 3 exit criterion).

import { type SafetyClass } from "./policy.ts";

/** A tool call the brain wants to make, as seen by the execution-layer gate. */
export interface ToolCall {
  tool: string; // raw MCP tool name, e.g. mcp__saple-bridge-control__spawn_agents
  action: string; // bare contract action, e.g. spawn_agents
  cls: SafetyClass;
  input: Record<string, unknown>;
  summary: string; // human-readable one-liner (policy.summarize)
}

export type GateDecision = { allow: true; input?: Record<string, unknown> } | { allow: false; reason: string };

/** The approval gate. Lives in June's core, not the brain. Called once per
 *  tool call before it can run; a `false` decision blocks execution entirely. */
export type ToolGate = (call: ToolCall) => Promise<GateDecision>;

/** Streaming surface for a single turn. Text deltas feed the UI/CLI as they
 *  arrive; tool events let the surface show "what June is doing" (PLAN.md §1). */
export interface TurnHooks {
  gate: ToolGate;
  onText?: (delta: string) => void;
  onToolUse?: (call: Pick<ToolCall, "tool" | "action" | "input">) => void;
  onToolResult?: (action: string, result: unknown, isError: boolean) => void;
}

export interface TurnResult {
  /** June's final reply text, derived only from tool results, never intent. */
  text: string;
  isError: boolean;
}

export interface Brain {
  readonly id: string; // "claude"
  readonly model: string; // "claude-opus-4-8"
  /** Run one user turn to completion, streaming through `hooks`. A brain is
   *  now long-lived (Phase 11.1): it keeps its MCP connections warm and its
   *  conversation history between calls, so successive turns share context. */
  run(prompt: string, hooks: TurnHooks): Promise<TurnResult>;
  /** Abort the in-flight turn, if any (barge-in / preemption). Idle -> no-op.
   *  The held session survives so the next turn keeps the conversation. */
  cancel(): void;
  /** Drop the accumulated conversation - the next `run` starts a fresh session
   *  (Phase 11.2 "new conversation"). Keeps warm resources where cheap. */
  reset(): void;
  /** Release warm resources (MCP connections, the held query). Called when the
   *  resident process shuts down. */
  dispose(): Promise<void>;
}
