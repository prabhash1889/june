import { describe, expect, it } from "vitest";

import { toOpenAiTool } from "./openai-brain.ts";

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
