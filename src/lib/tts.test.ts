import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._a: unknown[]) => [1, 2, 3]);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { CANNED_PHRASES, SentenceBuffer, synthesize } from "./tts.ts";

describe("synthesize canned-phrase memo (3.5)", () => {
  it("synthesizes a canned phrase once and replays it, but re-synthesizes other text", async () => {
    invoke.mockClear();
    await synthesize(CANNED_PHRASES.onIt);
    await synthesize(CANNED_PHRASES.onIt); // served from cache
    expect(invoke).toHaveBeenCalledTimes(1);

    await synthesize("A unique reply sentence.");
    await synthesize("A unique reply sentence."); // not canned -> synthesized again
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("re-synthesizes a canned phrase when the voice/provider changes", async () => {
    invoke.mockClear();
    await synthesize(CANNED_PHRASES.cancelled, { provider: "openai", voice: "alloy" });
    await synthesize(CANNED_PHRASES.cancelled, { provider: "openai", voice: "nova" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("SentenceBuffer", () => {
  it("flushes a sentence only once its terminator is followed by whitespace", () => {
    const b = new SentenceBuffer();
    expect(b.push("Started five agents")).toEqual([]); // no terminator yet
    expect(b.push(".")).toEqual([]); // terminator with nothing after -> wait
    expect(b.push(" and ")).toEqual(["Started five agents."]); // space arrives -> emit
  });

  it("emits multiple complete sentences from one delta and keeps the remainder", () => {
    const b = new SentenceBuffer();
    expect(b.push("Done. Ready! Now what")).toEqual(["Done.", "Ready!"]);
    expect(b.flush()).toBe("Now what");
  });

  it("treats a newline as an end of sentence", () => {
    const b = new SentenceBuffer();
    expect(b.push("First line\nsecond")).toEqual(["First line"]);
    expect(b.flush()).toBe("second");
  });

  it("flush returns the trailing partial and empties the buffer", () => {
    const b = new SentenceBuffer();
    b.push("Half a thought");
    expect(b.flush()).toBe("Half a thought");
    expect(b.flush()).toBe("");
  });
});
