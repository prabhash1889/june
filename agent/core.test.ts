// @vitest-environment node
// core.ts resolves MCP server paths via fileURLToPath(import.meta.url); jsdom (the
// repo default) hands import.meta.url a non-file URL, so pin this suite to node.
import { describe, expect, it } from "vitest";

import {
  automationMcpServer,
  defaultMcpServers,
  filesMcpServer,
  lessonsMcpServer,
  memoryMcpServer,
  systemMcpServer,
} from "./core.ts";

// 7.9: the Claude Agent SDK spawns MCP children with the resident's FULL env (its
// bundle has no inherit-allowlist), so the resident's ANTHROPIC_API_KEY /
// JUNE_BRAIN_API_KEY would otherwise reach every server, including a user-added one.
// Every built-in server config must blank those vars so a child can't read the key.
describe("built-in MCP servers scrub brain secrets (7.9)", () => {
  const builtins = {
    ...filesMcpServer("/root"),
    ...memoryMcpServer("/mem.md"),
    ...lessonsMcpServer("/lessons.md"),
    ...automationMcpServer("/settings.json"),
    ...systemMcpServer(),
    ...defaultMcpServers("ws-1"),
  };

  it("blanks ANTHROPIC_API_KEY / OPENAI_API_KEY / JUNE_BRAIN_API_KEY on every server", () => {
    for (const [id, cfg] of Object.entries(builtins)) {
      const env = (cfg as { env?: Record<string, string> }).env ?? {};
      expect(env.ANTHROPIC_API_KEY, `${id} leaks ANTHROPIC_API_KEY`).toBe("");
      expect(env.OPENAI_API_KEY, `${id} leaks OPENAI_API_KEY`).toBe("");
      expect(env.JUNE_BRAIN_API_KEY, `${id} leaks JUNE_BRAIN_API_KEY`).toBe("");
    }
  });

  it("still passes each server its own delta var alongside the blanks", () => {
    expect((filesMcpServer("/root").files as { env: Record<string, string> }).env.JUNE_FILES_ROOT).toBe("/root");
    expect(
      (automationMcpServer("/settings.json").automation as { env: Record<string, string> }).env.JUNE_SETTINGS_FILE,
    ).toBe("/settings.json");
    expect(
      (defaultMcpServers("ws-1")["saple-bridge-control"] as { env: Record<string, string> }).env.JUNE_WORKSPACE_ID,
    ).toBe("ws-1");
  });
});
