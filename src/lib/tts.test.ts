import { describe, expect, it } from "vitest";

import { SentenceBuffer } from "./tts.ts";

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
