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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { type Brain, type TurnHooks, type TurnResult } from "./brain.ts";
import { actionOf, classify, summarize } from "./policy.ts";

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

/** One connected MCP capability server plus the bare tool names it owns, so a
 *  tool call can be routed back to the right client. */
interface Connected {
  client: Client;
  close: () => Promise<void>;
  toolNames: Set<string>;
}

export class OpenAiCompatBrain implements Brain {
  readonly id: string;
  readonly model: string;
  #baseUrl: string;
  #apiKey?: string;
  #systemPrompt: string;
  #mcpServers: Record<string, McpServerConfig>;

  constructor(cfg: OpenAiCompatBrainConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
    this.#baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.#apiKey = cfg.apiKey;
    this.#systemPrompt = cfg.systemPrompt;
    this.#mcpServers = cfg.mcpServers;
  }

  async run(prompt: string, hooks: TurnHooks): Promise<TurnResult> {
    let servers: Connected[];
    try {
      servers = await this.#connect();
    } catch (e) {
      return { text: `June could not start its tools: ${errMsg(e)}`, isError: true };
    }

    try {
      const tools = await collectTools(servers);
      const routeOf = (name: string): Client | undefined =>
        servers.find((s) => s.toolNames.has(name))?.client;

      const messages: OpenAiMessage[] = [
        { role: "system", content: this.#systemPrompt },
        { role: "user", content: prompt },
      ];
      let finalText = "";

      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await this.#complete(messages, tools);
        messages.push(reply);
        if (reply.content) {
          finalText = reply.content;
          hooks.onText?.(reply.content);
        }
        const calls = reply.tool_calls ?? [];
        if (calls.length === 0) break;

        for (const call of calls) {
          const result = await this.#runToolCall(call, routeOf, hooks);
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }

      return { text: finalText || "I didn't produce a reply.", isError: !finalText };
    } catch (e) {
      return { text: `June hit an error: ${errMsg(e)}`, isError: true };
    } finally {
      await Promise.all(servers.map((s) => s.close().catch(() => {})));
    }
  }

  /** Execute one proposed tool call: classify it, run it past the gate, and only
   *  then dispatch it to the owning MCP server. A denied call returns the denial
   *  as the tool result so the model can react without ever running the tool. */
  async #runToolCall(
    call: OpenAiToolCall,
    routeOf: (name: string) => Client | undefined,
    hooks: TurnHooks,
  ): Promise<string> {
    const action = actionOf(call.function.name);
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      return `Error: the tool arguments were not valid JSON.`;
    }

    const cls = classify(action);
    const decision = await hooks.gate({ tool: call.function.name, action, cls, input, summary: summarize(action, input) });
    if (!decision.allow) return `Not run: ${decision.reason}`;
    const finalInput = decision.input ?? input;

    hooks.onToolUse?.({ tool: call.function.name, action, input: finalInput });
    const client = routeOf(call.function.name);
    if (!client) return `Error: no capability provides the tool "${call.function.name}".`;

    try {
      const res = (await client.callTool({ name: call.function.name, arguments: finalInput })) as {
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

  /** One chat-completions round-trip. Returns the assistant message. */
  async #complete(messages: OpenAiMessage[], tools: OpenAiTool[]): Promise<OpenAiMessage> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;

    const resp = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers,
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

  /** Connect to every configured MCP capability server as a client. */
  async #connect(): Promise<Connected[]> {
    const out: Connected[] = [];
    for (const cfg of Object.values(this.#mcpServers)) {
      if (!isStdio(cfg)) continue; // June only ships stdio MCP servers today
      const client = new Client({ name: `june-${this.id}`, version: "0.1.0" });
      const transport = new StdioClientTransport(stdioParams(cfg));
      await client.connect(transport);
      const { tools } = await client.listTools();
      out.push({
        client,
        close: () => client.close(),
        toolNames: new Set(tools.map((t) => t.name)),
      });
    }
    return out;
  }
}

type StdioConfig = { command: string; args?: string[]; env?: Record<string, string> };

function isStdio(cfg: McpServerConfig): cfg is StdioConfig & McpServerConfig {
  return typeof (cfg as { command?: unknown }).command === "string";
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

/** Gather all MCP tools across servers as OpenAI function tools. The pure
 *  per-tool translation is `toOpenAiTool`, unit-tested without a live model. */
async function collectTools(servers: Connected[]): Promise<OpenAiTool[]> {
  const out: OpenAiTool[] = [];
  for (const s of servers) {
    const { tools } = await s.client.listTools();
    for (const t of tools) out.push(toOpenAiTool(t));
  }
  return out;
}

/** MCP tool -> OpenAI function-tool schema. */
export function toOpenAiTool(t: { name: string; description?: string; inputSchema?: unknown }): OpenAiTool {
  const params =
    t.inputSchema && typeof t.inputSchema === "object"
      ? (t.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  return { type: "function", function: { name: t.name, description: t.description, parameters: params } };
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
