// The memory store's one bit of non-trivial logic (Phase 11.4): appending a fact
// and capping the file to the newest lines. Pure, so no file/server needed.

import { describe, expect, it } from "vitest";

import { appendFact, trimToBytes } from "./store.ts";

describe("appendFact", () => {
  it("adds a bullet, collapsing whitespace", () => {
    expect(appendFact("", "prefers   Codex\tagents", 1000)).toBe("- prefers Codex agents");
  });

  it("appends under an existing memory", () => {
    expect(appendFact("- likes dark mode", "repo at C:/dev/app", 1000)).toBe(
      "- likes dark mode\n- repo at C:/dev/app",
    );
  });
});

describe("trimToBytes", () => {
  it("keeps the whole text when it fits", () => {
    const text = "- a\n- b\n- c";
    expect(trimToBytes(text, 1000)).toBe(text);
  });

  it("drops the oldest lines to fit the cap, newest kept", () => {
    // Each "- x\n" is 4 bytes; a 9-byte cap holds the two newest lines.
    expect(trimToBytes("- a\n- b\n- c", 9)).toBe("- b\n- c");
  });

  it("keeps at least one line even if it alone exceeds the cap", () => {
    expect(trimToBytes("- a very long single fact", 5)).toBe("- a very long single fact");
  });
});
