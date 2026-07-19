import { beforeEach, describe, expect, it, vi } from "vitest";

import { percentile, TurnTimer } from "./latency.ts";

// Drive performance.now() so the stage maths is deterministic. Re-installed each
// test: the global setup's afterEach vi.restoreAllMocks() tears the spy down.
let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

describe("TurnTimer", () => {
  it("breaks a turn into stt/brain/tts and excludes the review pause from brain", () => {
    const t = new TurnTimer();
    clock = 100;
    t.captureEnded();
    clock = 300;
    t.gotTranscript(); // stt = 200
    clock = 1000;
    t.sent(); // review pause (300 -> 1000) is NOT counted
    clock = 1500;
    t.firstToken(); // brain = 500
    clock = 1800;
    const s = t.firstAudio(); // tts = 300
    expect(s).toEqual({ stt: 200, brain: 500, tts: 300, total: 1000 });
  });

  it("produces a sample only once", () => {
    const t = new TurnTimer();
    t.captureEnded();
    clock = 10;
    t.gotTranscript();
    t.sent();
    t.firstToken();
    clock = 20;
    expect(t.firstAudio()).not.toBeNull();
    expect(t.firstAudio()).toBeNull();
  });

  it("keeps the earliest first token when several deltas arrive", () => {
    const t = new TurnTimer();
    t.captureEnded();
    t.gotTranscript();
    t.sent();
    clock = 400;
    t.firstToken();
    clock = 900;
    t.firstToken(); // ignored
    clock = 1000;
    expect(t.firstAudio()?.brain).toBe(400);
  });

  it("falls back to the first-audio mark when the brain streamed no deltas", () => {
    const t = new TurnTimer();
    t.captureEnded();
    t.gotTranscript();
    t.sent(); // send at t=0
    clock = 600;
    const s = t.firstAudio(); // no firstToken() -> brain spans send..firstAudio, tts=0
    expect(s).toEqual({ stt: 0, brain: 600, tts: 0, total: 600 });
  });

  it("returns null for an abandoned turn that never reached Send", () => {
    const t = new TurnTimer();
    t.captureEnded();
    t.gotTranscript();
    expect(t.firstAudio()).toBeNull();
  });
});

describe("percentile", () => {
  it("is 0 for an empty list", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("uses nearest-rank (p95 of 1..100 is 95, p50 is 50)", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 100)).toBe(100);
  });

  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    expect(percentile(xs, 50)).toBe(2);
    expect(xs).toEqual([3, 1, 2]);
  });
});
