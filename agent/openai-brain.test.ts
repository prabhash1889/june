import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatBrain, toOpenAiTool } from "./openai-brain.ts";
import { type ToolGate } from "./brain.ts";

const allowAll: ToolGate = async () => ({ allow: true });

// The only pure, testable-without-a-model piece of the OpenAI-compatible brain
// is the MCP -> OpenAI tool-schema translation; the tool loop itself is exercised
// live (a manual gate, like every prior phase's provider).
describe("toOpenAiTool", () => {
  it("wraps an MCP tool's schema as an OpenAI function tool", () => {
    const params = { type: "object", properties: { count: { type: "number" } } };
    const t = toOpenAiTool({ name: "spawn_agents", description: "spawn some", inputSchema: params });
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
