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
//
// Phase 11.1/11.2: the brain is now LONG-LIVED. Instead of a fresh query() per
// turn (which re-spawns the SDK CLI and re-connects every MCP server each time),
// it holds ONE query() open in streaming-input mode. User turns are pushed into
// the query's async-iterable prompt; MCP connections and conversation history
// stay warm across turns, and canUseTool stays in-loop for spoken approvals
// (Phase 14). `cancel()` interrupts the in-flight turn; `reset()` ends the held
// session so the next turn starts a fresh conversation.

import {
  query,
  type McpServerConfig,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { type Brain, type TurnHooks, type TurnResult } from "./brain.ts";
import { actionOf, classify, serverOf, summarize } from "./policy.ts";

// Bound the agentic tool loop so a runaway model can't spin forever (1.6).
// Generous - a real mission task takes several tool rounds - but finite, so the
// turn always terminates with a spoken result instead of unbounded token spend.
const MAX_TURNS = 24;

export interface ClaudeBrainConfig {
  model?: string;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
  /** When false, the SDK does not write session history to disk (Phase 11.2:
   *  strict privacy modes keep nothing on disk). Defaults to true. */
  persistSession?: boolean;
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

/** A push/pull async queue of user messages feeding the held query's streaming
 *  prompt. `push` delivers a turn to a waiting `next()` (or buffers it); `end`
 *  closes the stream so the SDK query finishes. Exported for unit testing the
 *  buffer/wait ordering, which the streaming-input session relies on. */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  #buf: SDKUserMessage[] = [];
  #waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  #ended = false;

  push(msg: SDKUserMessage): void {
    if (this.#ended) return;
    const w = this.#waiting;
    if (w) {
      this.#waiting = null;
      w({ value: msg, done: false });
    } else {
      this.#buf.push(msg);
    }
  }

  end(): void {
    this.#ended = true;
    const w = this.#waiting;
    if (w) {
      this.#waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.#buf.shift();
        if (buffered) return Promise.resolve({ value: buffered, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

export class ClaudeBrain implements Brain {
  readonly id = "claude";
  readonly model: string;
  #systemPrompt: string;
  #mcpServers: Record<string, McpServerConfig>;
  #persistSession: boolean;

  // The held session: lazily created on the first run and kept open across
  // turns. `#hooks` points at the CURRENT turn's gate/stream so the single
  // canUseTool closure always routes to the live turn.
  #query: Query | null = null;
  #input: MessageQueue | null = null;
  #hooks: TurnHooks | null = null;

  constructor(cfg: ClaudeBrainConfig) {
    this.model = cfg.model ?? "claude-opus-4-8";
    this.#systemPrompt = cfg.systemPrompt;
    this.#mcpServers = cfg.mcpServers;
    this.#persistSession = cfg.persistSession ?? true;
  }

  /** The permission hook, routed to the current turn's gate. One closure serves
   *  every turn because it reads `#hooks`, which `run` swaps per turn. */
  #canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const hooks = this.#hooks;
    if (!hooks) return { behavior: "deny", message: "No active turn." };
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

  #ensureQuery(): void {
    if (this.#query) return;
    const input = new MessageQueue();
    this.#input = input;
    this.#query = query({
      prompt: input,
      options: {
        model: this.model,
        systemPrompt: this.#systemPrompt,
        mcpServers: this.#mcpServers,
        canUseTool: this.#canUseTool,
        // June's agent has NO built-in tools (no Bash/Read/Edit) and ignores the
        // developer's own Claude Code settings - it may only touch the workspace
        // through the attached MCP servers.
        tools: [],
        settingSources: [],
        permissionMode: "default",
        persistSession: this.#persistSession,
        // Bound the tool loop so a model that keeps calling tools can't spin
        // forever and run up unbounded spend (1.6) - the OpenAI brain caps its
        // step loop the same way. On hitting the cap the SDK ends the turn with a
        // `result` of subtype `error_max_turns`, mapped to a short spoken message.
        maxTurns: MAX_TURNS,
      },
    });
  }

  async run(prompt: string, hooks: TurnHooks): Promise<TurnResult> {
    this.#ensureQuery();
    // Capture the query reference NOW (1.5): a mid-turn reset() ("New
    // conversation") nulls `this.#query`, so reading `this.#query!` each loop
    // iteration would throw a raw TypeError. The captured `q` still points at the
    // (now-ended) query, whose next() resolves `done`, which the loop handles
    // gracefully as "the session ended". Same shape as the openai-brain B4.4 fix.
    const q = this.#query!;
    this.#hooks = hooks;
    this.#input!.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    });

    let finalText = "";
    let isError = false;
    // Correlate a tool_result back to the tool_use it answers: results arrive on a
    // later synthetic user turn carrying only `tool_use_id`, so without this map
    // every result reported as an empty action and batch counts (spawn_agents)
    // never rendered on the default brain (10.4).
    const actionById = new Map<string, string>();

    try {
      // Pull the shared query one turn's worth: read until this turn's `result`.
      // Only one turn runs at a time (the orchestrator serializes), so a single
      // consumer of the generator is safe.
      for (;;) {
        const next = await q.next();
        if (next.done) {
          // The session ended out from under us (crash/reset mid-turn).
          isError = true;
          finalText = finalText || "The agent session ended before replying.";
          break;
        }
        const msg = next.value;
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
          if (msg.subtype === "success") finalText = msg.result;
          else if (msg.subtype === "error_max_turns")
            // Hit the tool-loop bound (1.6): speak a short, actionable line rather
            // than the raw subtype.
            finalText = "I worked on that for a while without finishing. Ask me to keep going, or narrow it down.";
          else finalText = `June hit an error: ${msg.subtype}`;
          break;
        }
      }
    } finally {
      this.#hooks = null;
    }

    return { text: finalText, isError };
  }

  cancel(): void {
    // Interrupt the in-flight turn but keep the session so the conversation
    // survives (barge-in should not wipe memory). The pending run() loop sees a
    // `result` with subtype 'interrupt' and returns.
    this.#query?.interrupt().catch(() => {});
  }

  reset(): void {
    // End the held session; the next run lazily opens a fresh one, dropping all
    // prior conversation.
    this.#input?.end();
    void this.#query?.return?.(undefined).catch(() => {});
    this.#query = null;
    this.#input = null;
    this.#hooks = null;
  }

  async dispose(): Promise<void> {
    this.reset();
  }
}
