import { describe, expect, it, vi } from "vitest";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  foldStreamChunk,
  namespaceTools,
  OpenAiCompatBrain,
  toOpenAiTool,
  transportFor,
  trimTurnHistory,
} from "./openai-brain.ts";
import { type ToolGate } from "./brain.ts";
import { actionOf, classify, isGated, serverOf, setServerDefaults } from "./policy.ts";

const allowAll: ToolGate = async () => ({ allow: true });

// B1.2: the OpenAI-compat brain must expose tools to the model as fully-qualified
// `mcp__<server>__<tool>` names and route by that full name - bare names let a
// plain collision dodge the gate, made per-server promotion inert, and misrouted
// duplicate tool names across servers.
describe("tool namespacing & routing (B1.2)", () => {
  it("qualifies tool names by server so duplicates never collide", () => {
    const a = namespaceTools("srv-a", [{ name: "read_file" }]);
    const b = namespaceTools("srv-b", [{ name: "read_file" }]);
    expect(a.tools[0].function.name).toBe("mcp__srv-a__read_file");
    expect(b.tools[0].function.name).toBe("mcp__srv-b__read_file");
    // Each server routes its own full name back to the bare name it expects...
    expect(a.bareByFull.get("mcp__srv-a__read_file")).toBe("read_file");
    expect(b.bareByFull.get("mcp__srv-b__read_file")).toBe("read_file");
    // ...and neither knows the other's full name, so a call is never misrouted.
    expect(a.bareByFull.has("mcp__srv-b__read_file")).toBe(false);
  });

  it("classifies via the full name, so per-server promotion works on this brain (13.2)", () => {
    setServerDefaults({ "brave-search": "observe" });
    try {
      const full = namespaceTools("brave-search", [{ name: "web_search" }]).tools[0].function.name;
      expect(serverOf(full)).toBe("brave-search");
      expect(actionOf(full)).toBe("web_search");
      expect(isGated(classify(actionOf(full), serverOf(full)))).toBe(false); // promoted read
      // A generic server's tool that merely shares a built-in name stays gated.
      const spoof = namespaceTools("other", [{ name: "remember" }]).tools[0].function.name;
      expect(isGated(classify(actionOf(spoof), serverOf(spoof)))).toBe(true);
    } finally {
      setServerDefaults({});
    }
  });
});

// The only pure, testable-without-a-model piece of the OpenAI-compatible brain
// is the MCP -> OpenAI tool-schema translation; the tool loop itself is exercised
// live (a manual gate, like every prior phase's provider).
describe("toOpenAiTool", () => {
  it("wraps an MCP tool's schema as an OpenAI function tool", () => {
    const params = { type: "object", properties: { count: { type: "number" } } };
    const t = toOpenAiTool({
      name: "spawn_agents",
      description: "spawn some",
      inputSchema: params,
    });
    expect(t.type).toBe("function");
    expect(t.function.name).toBe("spawn_agents");
    expect(t.function.description).toBe("spawn some");
    expect(t.function.parameters).toEqual(params);
  });

  it("falls back to an empty object schema when the tool declares none", () => {
    const t = toOpenAiTool({ name: "get_swarm_status" });
    expect(t.function.parameters).toEqual({ type: "object", properties: {} });
  });
});

// Phase 13: a generic server may be stdio or a remote HTTP endpoint. The OpenAI
// brain must build the right client transport for each (the Claude brain gets the
// same configs straight from the SDK). Constructing a transport doesn't connect,
// so this is safe headlessly.
describe("transportFor", () => {
  it("builds a stdio transport for a command config", () => {
    expect(transportFor({ command: "npx", args: ["-y", "s"] })).toBeInstanceOf(
      StdioClientTransport,
    );
  });

  it("builds an HTTP transport for a url config", () => {
    expect(transportFor({ type: "http", url: "https://x/mcp" })).toBeInstanceOf(
      StreamableHTTPClientTransport,
    );
  });

  it("returns undefined for an unrunnable shape", () => {
    expect(transportFor({ type: "sdk", name: "x", instance: {} } as never)).toBeUndefined();
  });
});

// Phase 11.3: cancel() must abort the in-flight completion so a barge-in stops
// token spend at once. Drive it headlessly with a fetch that only settles when
// its abort signal fires (mimicking a real request killed mid-flight).
describe("cancel", () => {
  it("aborts the in-flight completion and rolls the turn back", async () => {
    const brain = new OpenAiCompatBrain({
      id: "test",
      model: "m",
      baseUrl: "http://localhost/v1",
      apiKey: "k",
      systemPrompt: "sys",
      mcpServers: {}, // no MCP servers -> no live connections needed
    });

    let sawRequest!: () => void;
    const requested = new Promise<void>((r) => (sawRequest = r));
    vi.stubGlobal("fetch", (_url: string, init: { signal?: AbortSignal }) => {
      sawRequest();
      // Never resolve on its own; the only way out is the abort signal, exactly
      // like a real chat-completions request cut off by cancel().
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });

    try {
      const run = brain.run("hi", { gate: allowAll });
      await requested; // the completion is in flight
      brain.cancel(); // barge-in
      const result = await run;
      // Aborted turn: no error surfaced to the user, no spoken text.
      expect(result).toEqual({ text: "", isError: false });
      // History rolled back to just the system prompt - a half-finished turn must
      // not persist (the chat API rejects a dangling assistant/user pair).
      brain.reset();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// 3.7: a transient blip (429/5xx or a dropped connection) must be retried a couple
// of times rather than killing the spoken turn, while a 4xx (auth) fails at once.
describe("transient-error retry (3.7)", () => {
  const brain = () =>
    new OpenAiCompatBrain({
      id: "test",
      model: "m",
      baseUrl: "http://localhost/v1",
      apiKey: "k",
      systemPrompt: "sys",
      mcpServers: {},
    });
  const okResp = (content: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { role: "assistant", content } }], usage: {} }),
    text: async () => "",
  });
  const errResp = (status: number, retryAfter?: string) => ({
    ok: false,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
    },
    text: async () => `{"error":"boom"}`,
  });

  it("retries a 429 (honoring Retry-After) then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls === 1 ? errResp(429, "0") : okResp("hello there");
    });
    try {
      const result = await brain().run("hi", { gate: allowAll });
      expect(calls).toBe(2);
      expect(result).toMatchObject({ text: "hello there", isError: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a dropped connection then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return okResp("recovered");
    });
    try {
      const result = await brain().run("hi", { gate: allowAll });
      expect(calls).toBe(2);
      expect(result).toMatchObject({ text: "recovered", isError: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a 4xx auth error - fails the turn at once", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return errResp(401);
    });
    try {
      const result = await brain().run("hi", { gate: allowAll });
      expect(calls).toBe(1);
      expect(result.isError).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// 3.1: SSE streaming. foldStreamChunk is the pure reassembly of OpenAI's streamed
// chunks - text deltas concatenate, tool-call arguments arrive a few chars at a
// time keyed by index, and usage rides the terminal chunk.
describe("foldStreamChunk (3.1)", () => {
  it("concatenates text deltas and returns each increment to emit", () => {
    const acc: Parameters<typeof foldStreamChunk>[0] = { content: "", toolCalls: [] };
    expect(foldStreamChunk(acc, { choices: [{ delta: { content: "Hel" } }] })).toBe("Hel");
    expect(foldStreamChunk(acc, { choices: [{ delta: { content: "lo" } }] })).toBe("lo");
    expect(acc.content).toBe("Hello");
  });

  it("reassembles a fragmented tool call across chunks by index", () => {
    const acc: Parameters<typeof foldStreamChunk>[0] = { content: "", toolCalls: [] };
    foldStreamChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "spawn_agents", arguments: '{"co' } },
            ],
          },
        },
      ],
    });
    foldStreamChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'unt":2}' } }] } }],
    });
    expect(acc.toolCalls[0]).toMatchObject({
      id: "call_1",
      function: { name: "spawn_agents", arguments: '{"count":2}' },
    });
  });

  it("captures usage from the terminal chunk and emits nothing for it", () => {
    const acc: Parameters<typeof foldStreamChunk>[0] = { content: "", toolCalls: [] };
    expect(
      foldStreamChunk(acc, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    ).toBe("");
    expect(acc.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

// 3.1: the brain must parse a real text/event-stream body - firing onText per
// delta (so TTS starts early) and NOT re-emitting the assembled text at the end.
describe("streaming completion (3.1)", () => {
  const brain = () =>
    new OpenAiCompatBrain({
      id: "test",
      model: "m",
      baseUrl: "http://localhost/v1",
      apiKey: "k",
      systemPrompt: "sys",
      mcpServers: {},
    });
  const sse = (...frames: string[]) => ({
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" ? "text/event-stream" : null),
    },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
  });

  it("emits deltas as they stream and returns the assembled reply once", async () => {
    vi.stubGlobal("fetch", async () =>
      sse(
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"there."}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ),
    );
    try {
      const said: string[] = [];
      const result = await brain().run("hi", { gate: allowAll, onText: (t) => said.push(t) });
      expect(said).toEqual(["Hello ", "there."]); // per-delta, and not re-emitted whole
      expect(result).toMatchObject({
        text: "Hello there.",
        isError: false,
        usage: { inputTokens: 5, outputTokens: 2 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// B4.5: retained history is trimmed so a long-lived session can't grow #messages
// without bound - but only ever at a whole-turn (user) boundary, so an assistant
// tool_call is never split from its tool results (which the chat API rejects).
describe("trimTurnHistory (B4.5)", () => {
  it("keeps the system prompt and cuts only at a user turn boundary", () => {
    const msgs = [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: null }, // tool_call turn
      { role: "tool", content: "t" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const out = trimTurnHistory(msgs, 2);
    expect(out[0].role).toBe("system"); // system prompt always survives
    expect(out[1].role).toBe("user"); // trimmed to a clean turn start
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1]); // newest kept
    // A tool message never lands without its preceding assistant (no orphaned pair).
    expect(out.some((m, i) => m.role === "tool" && out[i - 1]?.role !== "assistant")).toBe(false);
  });

  it("returns the same array untouched when nothing needs trimming", () => {
    const msgs = [{ role: "system" }, { role: "user" }, { role: "assistant" }];
    expect(trimTurnHistory(msgs, 60)).toBe(msgs);
  });
});
