// The OpenAI-compatible brain (PLAN.md §3, Phase 7: "the full roster lives
// here"). One impl of the provider-neutral Brain interface that covers OpenAI
// GPT, Google Gemini (its OpenAI-compatible endpoint), Ollama, LM Studio, and
// any custom OpenAI-compatible server - they differ only by base URL, model,
// and key, so they are config, not code (§3: "adding a brain is a config entry,
// not a new loop").
//
// Unlike ClaudeBrain (which gets the MCP client + tool loop from the Agent SDK),
// this runs the loop itself: it connects to June's MCP capability servers as an
// MCP client, exposes their tools to the chat-completions API, and - crucially -
// routes every proposed tool call through the SAME execution-layer gate the
// orchestrator passes in (TurnHooks.gate). That is what makes the approval gate
// hold "regardless of provider" (Phase 3/7 exit): swapping Claude for GPT cannot
// skip a gate because the gate lives here in the loop, not in the model.
//
// ponytail: non-streaming completions - onText fires once per assistant message.
// The sentence buffer downstream still splits it for speech, and Claude covers
// the streaming path. SSE streaming for non-Claude brains is a later refinement.
//
// Phase 11.1/11.2: long-lived like ClaudeBrain. MCP servers are connected once
// and kept warm across turns; the `messages` array persists so the conversation
// carries over. `cancel()` aborts the in-flight completion; `reset()` clears the
// history back to the system prompt; `dispose()` closes the warm connections.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { type Brain, type TurnHooks, type TurnResult } from "./brain.ts";
import { actionOf, classify, serverOf, summarize } from "./policy.ts";

export interface OpenAiCompatBrainConfig {
  id: string; // provider id, e.g. "openai" | "ollama" | "custom"
  model: string;
  baseUrl: string; // OpenAI-compatible root, e.g. https://api.openai.com/v1
  apiKey?: string; // omitted for local servers (Ollama / LM Studio)
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
}

// Bound the tool loop so a model that keeps calling tools can't spin forever.
const MAX_STEPS = 12;

// Cap retained conversation turns so a long-lived session can't grow `#messages`
// without bound (B4.5). Generous (trimming drops older context) and always cut at
// a whole-turn boundary so a tool result never loses its assistant tool_call.
const MAX_HISTORY = 60;

interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}
interface OpenAiTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** One connected MCP capability server, its tools translated to OpenAI schema
 *  under fully-qualified `mcp__<server>__<tool>` names (B1.2), and the map from
 *  those full names back to the bare name the MCP server itself expects. The full
 *  names are what the model sees and what the gate classifies, so a generic
 *  server's `read_file` can't collide with June's built-in one, and two servers
 *  sharing a bare tool name route to the right client. */
interface Connected {
  client: Client;
  close: () => Promise<void>;
  bareByFull: Map<string, string>;
  tools: OpenAiTool[];
}

/** Namespace a server's tools as `mcp__<server>__<tool>` and build the full->bare
 *  routing map (B1.2). Pure, so the namespacing/routing is unit-tested without a
 *  live MCP connection. */
export function namespaceTools(
  serverId: string,
  tools: { name: string; description?: string; inputSchema?: unknown }[],
): { tools: OpenAiTool[]; bareByFull: Map<string, string> } {
  const bareByFull = new Map<string, string>();
  const out = tools.map((t) => {
    const full = `mcp__${serverId}__${t.name}`;
    bareByFull.set(full, t.name);
    return toOpenAiTool({ ...t, name: full });
  });
  return { tools: out, bareByFull };
}

export class OpenAiCompatBrain implements Brain {
  readonly id: string;
  readonly model: string;
  #baseUrl: string;
  #apiKey?: string;
  #systemPrompt: string;
  #mcpServers: Record<string, McpServerConfig>;

  // Warm state, held across turns (Phase 11.1). `#servers` are connected once;
  // `#messages` accumulates the conversation so successive turns share context.
  #servers: Connected[] | null = null;
  #messages: OpenAiMessage[] = [{ role: "system", content: "" }];
  #abort: AbortController | null = null;

  constructor(cfg: OpenAiCompatBrainConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
    this.#baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.#apiKey = cfg.apiKey;
    this.#systemPrompt = cfg.systemPrompt;
    this.#mcpServers = cfg.mcpServers;
    this.#messages = [{ role: "system", content: this.#systemPrompt }];
  }

  async run(prompt: string, hooks: TurnHooks): Promise<TurnResult> {
    let servers: Connected[];
    try {
      servers = await this.#ensureConnected();
    } catch (e) {
      return { text: `June could not start its tools: ${errMsg(e)}`, isError: true };
    }

    const abort = new AbortController();
    this.#abort = abort;
    // Operate on the history array CAPTURED NOW (B4.4): a mid-turn reset() swaps the
    // `#messages` FIELD to a fresh array, so rolling back or appending must target
    // this captured reference, never the field - otherwise a mid-turn rollback
    // truncates (corrupts) the freshly-reset conversation. `mark` snapshots the
    // length so a mid-turn failure/barge-in rolls back to a consistent state (the
    // chat API rejects an assistant tool_call with no matching tool result, so a
    // half-finished turn must never persist).
    const history = this.#messages;
    const mark = history.length;
    history.push({ role: "user", content: prompt });

    try {
      const tools = servers.flatMap((s) => s.tools);
      // Route a full `mcp__<server>__<tool>` name to its owning client and the
      // bare name that client expects (B1.2).
      const routeOf = (name: string): { client: Client; bare: string } | undefined => {
        for (const s of servers) {
          const bare = s.bareByFull.get(name);
          if (bare !== undefined) return { client: s.client, bare };
        }
        return undefined;
      };

      let finalText = "";
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await this.#complete(history, tools, abort.signal);
        history.push(reply);
        if (reply.content) {
          finalText = reply.content;
          hooks.onText?.(reply.content);
        }
        const calls = reply.tool_calls ?? [];
        if (calls.length === 0) break;

        for (const call of calls) {
          const result = await this.#runToolCall(call, routeOf, hooks);
          history.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }

      // Trim retained history so it can't grow without bound across turns (B4.5);
      // no-op if a reset() swapped `#messages` mid-turn (leave the fresh one).
      this.#trimHistory(history);
      return { text: finalText || "I didn't produce a reply.", isError: !finalText };
    } catch (e) {
      // Roll back the CAPTURED array (B4.4). If a reset swapped the field mid-turn,
      // this rewinds the now-discarded old array and leaves the fresh one intact.
      history.length = mark;
      const aborted = abort.signal.aborted;
      return {
        text: aborted ? "" : `June hit an error: ${errMsg(e)}`,
        isError: !aborted,
      };
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
  }

  cancel(): void {
    this.#abort?.abort();
  }

  reset(): void {
    this.#messages = [{ role: "system", content: this.#systemPrompt }];
  }

  /** Trim retained history to the most recent turns (B4.5). No-op if a reset()
   *  swapped `#messages` for a fresh array mid-turn - leave that one alone. */
  #trimHistory(history: OpenAiMessage[]): void {
    if (this.#messages === history) this.#messages = trimTurnHistory(history, MAX_HISTORY);
  }

  async dispose(): Promise<void> {
    const servers = this.#servers;
    this.#servers = null;
    if (servers) await Promise.all(servers.map((s) => s.close().catch(() => {})));
  }

  /** Execute one proposed tool call: classify it, run it past the gate, and only
   *  then dispatch it to the owning MCP server. A denied call returns the denial
   *  as the tool result so the model can react without ever running the tool. */
  async #runToolCall(
    call: OpenAiToolCall,
    routeOf: (name: string) => { client: Client; bare: string } | undefined,
    hooks: TurnHooks,
  ): Promise<string> {
    const fullName = call.function.name;
    const action = actionOf(fullName);
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      return `Error: the tool arguments were not valid JSON.`;
    }

    const cls = classify(action, serverOf(fullName));
    const decision = await hooks.gate({ tool: fullName, action, cls, input, summary: summarize(action, input) });
    if (!decision.allow) return `Not run: ${decision.reason}`;
    const finalInput = decision.input ?? input;

    hooks.onToolUse?.({ tool: fullName, action, input: finalInput });
    const route = routeOf(fullName);
    if (!route) return `Error: no capability provides the tool "${fullName}".`;

    try {
      // The MCP server knows its own BARE tool name; the `mcp__server__` prefix is
      // June-side routing only (B1.2).
      const res = (await route.client.callTool({ name: route.bare, arguments: finalInput })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("")
        .trim();
      hooks.onToolResult?.(action, parseMaybe(text), res.isError === true);
      return text || (res.isError ? "The tool reported an error." : "Done.");
    } catch (e) {
      hooks.onToolResult?.(action, { error: errMsg(e) }, true);
      return `Error running the tool: ${errMsg(e)}`;
    }
  }

  /** One chat-completions round-trip. Returns the assistant message. The abort
   *  signal lets a barge-in/cancel stop token spend mid-flight. */
  async #complete(messages: OpenAiMessage[], tools: OpenAiTool[], signal?: AbortSignal): Promise<OpenAiMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;

    const resp = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`the model API returned ${resp.status}: ${body.slice(0, 300).trim()}`);
    }
    const json = (await resp.json()) as { choices?: { message?: OpenAiMessage }[] };
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error("the model API returned no message.");
    return { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls };
  }

  /** Connect to every configured MCP capability server as a client, once, and
   *  keep the connections warm for the life of the brain (Phase 11.1). */
  async #ensureConnected(): Promise<Connected[]> {
    if (this.#servers) return this.#servers;
    const out: Connected[] = [];
    for (const [serverId, cfg] of Object.entries(this.#mcpServers)) {
      const transport = transportFor(cfg);
      if (!transport) continue; // unsupported config shape - skip, never crash the turn
      const client = new Client({ name: `june-${this.id}`, version: "0.1.0" });
      try {
        await client.connect(transport);
        // One listTools per server: names for routing and schemas for the model
        // both come from this single call (10.8 - was fetched twice). Namespace the
        // tools by server id so the gate classifies per-server and names never
        // collide across servers (B1.2).
        const { tools } = await client.listTools();
        const ns = namespaceTools(serverId, tools);
        out.push({
          client,
          close: () => client.close(),
          bareByFull: ns.bareByFull,
          tools: ns.tools,
        });
      } catch (e) {
        // One failing server must not fail the whole turn or orphan the clients
        // that DID connect on every retry (1.7): close this one, skip it, keep the
        // rest. The turn runs with the surviving tools instead of crashing.
        await client.close().catch(() => {});
        console.error(`[june] MCP server "${serverId}" failed to connect: ${errMsg(e)}`);
      }
    }
    // Cache the surviving set so a later turn reuses the warm connections rather
    // than reconnecting (which would leak). A config change respawns the resident,
    // which is how a fixed server gets retried.
    this.#servers = out;
    return out;
  }
}

type StdioConfig = { command: string; args?: string[]; env?: Record<string, string> };
type HttpConfig = { type?: string; url: string; headers?: Record<string, string> };

function isStdio(cfg: McpServerConfig): cfg is StdioConfig & McpServerConfig {
  return typeof (cfg as { command?: unknown }).command === "string";
}

function isHttp(cfg: McpServerConfig): cfg is HttpConfig & McpServerConfig {
  const c = cfg as { type?: unknown; url?: unknown };
  return (c.type === "http" || c.type === "sse") && typeof c.url === "string";
}

/** Build the MCP client transport for one server config, or undefined for a
 *  shape this brain can't run (Phase 13: generic servers may be stdio OR a remote
 *  HTTP endpoint). The Claude brain gets the same servers straight from the SDK. */
export function transportFor(cfg: McpServerConfig): Transport | undefined {
  if (isStdio(cfg)) return new StdioClientTransport(stdioParams(cfg));
  if (isHttp(cfg)) {
    const headers = cfg.headers;
    return new StreamableHTTPClientTransport(new URL(cfg.url), headers ? { requestInit: { headers } } : undefined);
  }
  return undefined;
}

/** Build StdioClientTransport params, wrapping `npx` through the shell on Windows
 *  (npx is a .cmd shim that can't be spawned directly - the same fix
 *  agent_runner.rs applies for the run-once child). */
function stdioParams(cfg: StdioConfig): { command: string; args: string[]; env?: Record<string, string> } {
  const args = cfg.args ?? [];
  if (process.platform === "win32" && cfg.command === "npx") {
    return { command: "cmd", args: ["/C", "npx", ...args], env: cfg.env };
  }
  return { command: cfg.command, args, env: cfg.env };
}

/** MCP tool -> OpenAI function-tool schema. The pure per-tool translation,
 *  unit-tested without a live model; each server's tools are translated once at
 *  connect time and reused for the whole turn. */
export function toOpenAiTool(t: { name: string; description?: string; inputSchema?: unknown }): OpenAiTool {
  const params =
    t.inputSchema && typeof t.inputSchema === "object"
      ? (t.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  return { type: "function", function: { name: t.name, description: t.description, parameters: params } };
}

/** Keep the system message plus the most recent turns of `messages`, capped at
 *  `maxHistory` messages after the system prompt (B4.5). Cuts ONLY at a `user`
 *  message (a turn boundary) so an assistant tool_call is never split from its
 *  tool results, which the chat API rejects. Returns the same array when nothing
 *  needs trimming. Pure, so the boundary logic is unit-tested. */
export function trimTurnHistory<T extends { role: string }>(messages: T[], maxHistory: number): T[] {
  if (messages.length <= 1 + maxHistory) return messages;
  let cut = messages.length - maxHistory;
  while (cut < messages.length && messages[cut].role !== "user") cut++;
  if (cut >= messages.length) return messages; // no boundary in range - keep as-is
  return [messages[0], ...messages.slice(cut)];
}

function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
