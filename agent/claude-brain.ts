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

import { join } from "node:path";

import {
  query,
  type McpServerConfig,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { type Brain, type TokenUsage, type TurnHooks, type TurnResult } from "./brain.ts";
import { friendlyApiError, statusFromMessage } from "./errors.ts";
import { actionOf, classify, serverOf, summarize } from "./policy.ts";

// Bound the agentic tool loop so a runaway model can't spin forever (1.6).
// Generous - a real mission task takes several tool rounds - but finite, so the
// turn always terminates with a spoken result instead of unbounded token spend.
const MAX_TURNS = 24;

// In-session context trim (3.2). The held query grows every turn until the 10-min
// idle reset, so a long ACTIVE session gets slower and pricier each turn. Mirror
// the OpenAI brain's rolling-history cap (B4.5): at this many turns, reset the SDK
// session and re-seed a fresh one with a short recap of the most recent exchanges,
// so continuity survives the trim. The SDK exposes no rolling-trim lever (only a
// per-query `maxTurns` bound and near-window auto-compaction), so we bound it here.
const CONTEXT_TRIM_TURNS = 30;
// How many recent exchanges to carry across a trim as the recap.
const RECAP_TURNS = 3;

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

  // In-session context trim (3.2). `#turnCount` grows per completed turn; at
  // CONTEXT_TRIM_TURNS the next run resets the session and prepends `#recap` (built
  // from the last RECAP_TURNS exchanges) to the first prompt so continuity holds.
  #turnCount = 0;
  #recent: { you: string; june: string }[] = [];
  #recap: string | null = null;

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
    // Packaged builds (improvement-7 1.1): the SDK normally resolves its native
    // Claude Code binary from a sibling node_modules package, which a bundled
    // serve.mjs no longer has - the host ships the binary in the app resources
    // and points JUNE_BUNDLE_DIR at them.
    const bundleDir = process.env.JUNE_BUNDLE_DIR;
    const claudeExe = process.platform === "win32" ? "claude.exe" : "claude";
    this.#query = query({
      prompt: input,
      options: {
        ...(bundleDir ? { pathToClaudeCodeExecutable: join(bundleDir, claudeExe) } : {}),
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
        // Stream text deltas as they're generated (3.6) so June can start speaking
        // the first sentence well before the whole block finishes - the default
        // (whole finished blocks only) inflates time-to-first-audio. The full
        // `assistant` block still arrives and is used as a dedupe fallback in run().
        includePartialMessages: true,
      },
    });
  }

  async run(prompt: string, hooks: TurnHooks): Promise<TurnResult> {
    // In-session context trim (3.2): once the session has run long enough, end it
    // and carry a recap of the recent exchanges into a fresh one before this turn,
    // so growth is bounded without losing the thread of the conversation.
    if (this.#turnCount >= CONTEXT_TRIM_TURNS) {
      const recap = this.#buildRecap();
      this.reset(); // clears query/input/counters/recap
      this.#recap = recap;
    }
    this.#ensureQuery();
    // Prepend the pending recap (if any) to the first prompt of the fresh session.
    const seeded = this.#recap ? `${this.#recap}\n\n${prompt}` : prompt;
    this.#recap = null;
    // Capture the query reference NOW (1.5): a mid-turn reset() ("New
    // conversation") nulls `this.#query`, so reading `this.#query!` each loop
    // iteration would throw a raw TypeError. The captured `q` still points at the
    // (now-ended) query, whose next() resolves `done`, which the loop handles
    // gracefully as "the session ended". Same shape as the openai-brain B4.4 fix.
    const q = this.#query!;
    this.#hooks = hooks;
    this.#input!.push({
      type: "user",
      message: { role: "user", content: seeded },
      parent_tool_use_id: null,
    });

    let finalText = "";
    let isError = false;
    let usage: TokenUsage | undefined;
    // 3.6: true once the current assistant message's text arrived as streamed
    // deltas, so the full `assistant` block that follows is skipped (not spoken
    // twice). Reset per assistant message so a message whose deltas didn't stream
    // still falls back to its whole block.
    let streamedText = false;
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
        if (msg.type === "stream_event") {
          // Streamed text delta (3.6): emit it immediately so the first sentence
          // reaches TTS as soon as it forms, and mark the block streamed so the
          // full-block fallback below doesn't re-emit the same text.
          const ev = msg.event;
          if (
            ev.type === "content_block_delta" &&
            ev.delta.type === "text_delta" &&
            ev.delta.text
          ) {
            streamedText = true;
            hooks.onText?.(ev.delta.text);
          }
        } else if (msg.type === "assistant") {
          for (const block of msg.message.content as ContentBlock[]) {
            // Only speak the whole text block when deltas did NOT stream it (dedupe
            // fallback); otherwise the deltas already delivered every character.
            if (block.type === "text" && block.text) {
              if (!streamedText) hooks.onText?.(block.text);
            } else if (block.type === "tool_use") {
              const action = actionOf(block.name ?? "");
              if (block.id) actionById.set(block.id, action);
              hooks.onToolUse?.({ tool: block.name ?? "", action, input: block.input ?? {} });
            }
          }
          streamedText = false; // next assistant message decides afresh
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
          // The SDK's terminal result carries this turn's token usage and its
          // dollar cost (2.6). Fold the cache-token counts into inputTokens so the
          // readout reflects everything billed. Present on every subtype, not just
          // success, so a maxed-out or errored turn still records what it spent.
          usage = {
            inputTokens:
              (msg.usage?.input_tokens ?? 0) +
              (msg.usage?.cache_read_input_tokens ?? 0) +
              (msg.usage?.cache_creation_input_tokens ?? 0),
            outputTokens: msg.usage?.output_tokens ?? 0,
            costUsd: msg.total_cost_usd,
          };
          isError = msg.subtype !== "success";
          if (msg.subtype === "success") finalText = msg.result;
          else if (msg.subtype === "error_max_turns")
            // Hit the tool-loop bound (1.6): speak a short, actionable line rather
            // than the raw subtype.
            finalText =
              "I worked on that for a while without finishing. Ask me to keep going, or narrow it down.";
          else finalText = `June hit an error: ${msg.subtype}`;
          break;
        }
      }
    } catch (e) {
      // The SDK surfaces API failures (bad key, rate limit) as thrown errors whose
      // message can carry the raw status/body. Keep the raw text in the log and
      // speak only a short mapped sentence (2.5), never the raw blob.
      const raw = e instanceof Error ? e.message : String(e);
      console.error(`[june] claude brain error: ${raw}`);
      const status = statusFromMessage(raw);
      finalText =
        (status && friendlyApiError(status)) ||
        "I hit an error talking to the model. Try again in a moment.";
      isError = true;
    } finally {
      this.#hooks = null;
    }

    // Record this exchange for the trim recap and count the turn (3.2). A mid-turn
    // reset() may have zeroed these, in which case this just seeds the fresh
    // session's recent window - harmless.
    this.#turnCount++;
    this.#recent.push({ you: prompt, june: finalText });
    if (this.#recent.length > RECAP_TURNS) this.#recent.shift();

    return { text: finalText, isError, usage };
  }

  /** Build a compact recap of the most recent exchanges to carry across a context
   *  trim (3.2), so the fresh session continues the conversation instead of losing
   *  it. ponytail: plaintext prompt/reply pairs, no tool-call detail - enough to
   *  keep continuity; upgrade to a model-generated summary only if that proves thin. */
  #buildRecap(): string {
    const lines = this.#recent.map((e) => `You: ${e.you}\nJune: ${e.june}`).join("\n\n");
    return `[Recap of the earlier conversation so far, continue naturally from it:]\n${lines}`;
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
    // Drop the trim bookkeeping too: a fresh conversation starts a fresh window,
    // and a public reset ("New conversation") must not leak a stale recap (3.2).
    this.#turnCount = 0;
    this.#recent = [];
    this.#recap = null;
  }

  async dispose(): Promise<void> {
    this.reset();
  }
}
