import { describe, expect, it } from "vitest";

import { phraseMatches } from "./wake.ts";

// phraseMatches is the whole low-false-trigger contract of the wake word: it must
// fire on the phrase (tolerating STT slop) and stay quiet on unrelated speech
// (PLAN.md Phase 8 exit: "reliably with low false triggers").
describe("phraseMatches", () => {
  it("matches the phrase verbatim and through STT punctuation/case", () => {
    expect(phraseMatches("hey june", "hey june")).toBe(true);
    expect(phraseMatches("Hey, June!", "hey june")).toBe(true);
    expect(phraseMatches("okay so hey june open a browser", "hey june")).toBe(true);
  });

  it("tolerates small mishears at the default sensitivity", () => {
    expect(phraseMatches("hey juno", "hey june", 0.5)).toBe(true); // one-char slip
    expect(phraseMatches("hey dune", "hey june", 0.5)).toBe(true);
  });

  it("stays quiet on unrelated speech", () => {
    expect(phraseMatches("what time is it", "hey june")).toBe(false);
    expect(phraseMatches("the news today", "hey june")).toBe(false);
    expect(phraseMatches("", "hey june")).toBe(false);
  });

  it("is stricter at high sensitivity (exact only) and looser at low", () => {
    expect(phraseMatches("hey dune", "hey june", 1)).toBe(false); // no slop allowed
    expect(phraseMatches("hey june", "hey june", 1)).toBe(true); // exact still fires
    expect(phraseMatches("hay dune", "hey june", 0.5)).toBe(false); // 2 edits, too far
    expect(phraseMatches("hay dune", "hey june", 0.1)).toBe(true); // very loose
  });

  it("never matches an empty phrase", () => {
    expect(phraseMatches("anything at all", "")).toBe(false);
  });
});
