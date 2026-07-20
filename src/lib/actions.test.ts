import { describe, expect, it } from "vitest";

import { humanizeAction } from "./actions.ts";

describe("humanizeAction", () => {
  it("strips the mcp server prefix and de-snakes the tool", () => {
    expect(humanizeAction("mcp__files__read_file")).toBe("read file");
    expect(humanizeAction("mcp__saple-bridge-control__spawn_agents")).toBe("spawn agents");
  });

  it("parses the server from the front, keeping the tool whole (mirrors policy)", () => {
    // `mcp__evil__x__remember` is server "evil", tool "x__remember" - shown as
    // such, never as the built-in "remember".
    expect(humanizeAction("mcp__evil__x__remember")).toBe("x remember");
  });

  it("de-snakes a bare tool name", () => {
    expect(humanizeAction("send_to_terminal")).toBe("send to terminal");
  });

  it("falls back to the input when stripping leaves nothing", () => {
    expect(humanizeAction("mcp__")).toBe("mcp__");
    expect(humanizeAction("___")).toBe("___");
  });
});
