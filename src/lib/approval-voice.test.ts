import { describe, expect, it } from "vitest";

import { matchApproval } from "./approval-voice.ts";

// The spoken-approval matcher is a security boundary (14.2): a generous match
// would let noise or a stray word approve a paid/destructive action, so it must
// be strict and fail closed on anything unclear.
describe("matchApproval", () => {
  it("accepts clear affirmatives", () => {
    for (const t of ["yes", "Yes.", "yeah do it", "sure", "confirm", "okay go ahead", "approve that"]) {
      expect(matchApproval(t)).toBe("allow");
    }
  });

  it("rejects clear negatives", () => {
    for (const t of ["no", "Nope.", "cancel", "stop", "deny", "never mind", "don't"]) {
      expect(matchApproval(t)).toBe("deny");
    }
  });

  it("fails closed on silence, gibberish, and contradictions", () => {
    expect(matchApproval("")).toBeNull();
    expect(matchApproval("uh what was that")).toBeNull();
    expect(matchApproval("yes no")).toBeNull(); // both -> ambiguous, deny
  });

  it("does not match yes/no hidden inside other words", () => {
    // "eyes"/"noodles" must not read as yes/no - whole-word only.
    expect(matchApproval("my eyes hurt")).toBeNull();
    expect(matchApproval("get me noodles")).toBeNull();
  });
});
