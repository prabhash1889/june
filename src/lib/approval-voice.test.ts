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

  it("never approves on a bare 'ok'/'okay' (B1.4: Whisper hallucinates it on silence)", () => {
    // Cloud Whisper emits "Okay." for a silent clip, which used to approve a paid
    // action. A bare ok/okay is no longer a sole affirmative -> fail closed.
    expect(matchApproval("okay")).toBeNull();
    expect(matchApproval("ok")).toBeNull();
    // A real affirmative phrasing still works ("okay go ahead" hits "go ahead").
    expect(matchApproval("okay go ahead")).toBe("allow");
  });

  it("reads a negated confirmation as a denial, not a yes (B1.4)", () => {
    // "not"/"do not" now count as NO, so a yes+no phrasing is a contradiction ->
    // null -> the caller fails closed and denies.
    expect(matchApproval("sure do not do it")).toBeNull();
    expect(matchApproval("yes not that one")).toBeNull();
    expect(matchApproval("do not")).toBe("deny");
  });
});
