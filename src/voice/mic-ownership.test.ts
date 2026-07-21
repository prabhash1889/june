import { expect, it } from "vitest";

import { ambientMicBlocked, followUpMayArm, wakeMayArm } from "./mic-ownership.ts";

const clear = { micMuted: false, voiceBlocked: false, hasApproval: false, dictation: false };

it("blocks the ambient mic when any single owner-blocker is set", () => {
  expect(ambientMicBlocked(clear)).toBe(false);
  for (const k of ["micMuted", "voiceBlocked", "hasApproval", "dictation"] as const) {
    expect(ambientMicBlocked({ ...clear, [k]: true })).toBe(true);
  }
});

it("wake arms only when enabled, idle, and unblocked", () => {
  expect(wakeMayArm(true, "idle", clear)).toBe(true);
  expect(wakeMayArm(false, "idle", clear)).toBe(false); // feature off
  expect(wakeMayArm(true, "listening", clear)).toBe(false); // not at rest
  expect(wakeMayArm(true, "idle", { ...clear, micMuted: true })).toBe(false);
  expect(wakeMayArm(true, "idle", { ...clear, hasApproval: true })).toBe(false);
});

it("follow-up arms only in the post-reply window, unblocked", () => {
  expect(followUpMayArm(true, "reply", clear)).toBe(true);
  expect(followUpMayArm(false, "reply", clear)).toBe(false);
  expect(followUpMayArm(true, "idle", clear)).toBe(false); // wrong phase
  expect(followUpMayArm(true, "reply", { ...clear, dictation: true })).toBe(false);
});
