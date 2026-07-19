import { describe, expect, it } from "vitest";

import { classifyGetUserMediaError, rms, SilenceDetector } from "./voice-capture.ts";

describe("SilenceDetector", () => {
  it("never ends on silence before any speech (slow starter)", () => {
    const d = new SilenceDetector(0.015, 1000);
    for (let i = 0; i < 50; i++) expect(d.push(0, 100)).toBe(false); // 5s of pre-speech silence
    expect(d.heardSpeech).toBe(false);
  });

  it("ends after the hangover of trailing silence once speech was heard", () => {
    const d = new SilenceDetector(0.015, 1000);
    expect(d.push(0.1, 100)).toBe(false); // speech
    expect(d.heardSpeech).toBe(true);
    // 900ms of silence: not yet
    for (let i = 0; i < 9; i++) expect(d.push(0, 100)).toBe(false);
    // crossing 1000ms: end of utterance
    expect(d.push(0, 100)).toBe(true);
  });

  it("resets the silence timer when speech resumes", () => {
    const d = new SilenceDetector(0.015, 500);
    d.push(0.1, 100); // speech
    d.push(0, 400); // 400ms silence
    expect(d.push(0.1, 100)).toBe(false); // speech again -> reset
    for (let i = 0; i < 4; i++) expect(d.push(0, 100)).toBe(false); // 400ms
    expect(d.push(0, 100)).toBe(true); // now 500ms
  });
});

describe("rms", () => {
  it("is zero for silence and grows with amplitude", () => {
    expect(rms(new Float32Array([0, 0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1);
  });
});

describe("classifyGetUserMediaError", () => {
  it("maps permission and device errors to distinct kinds", () => {
    expect(classifyGetUserMediaError(new DOMException("x", "NotAllowedError")).kind).toBe("permission-denied");
    expect(classifyGetUserMediaError(new DOMException("x", "NotFoundError")).kind).toBe("no-device");
    expect(classifyGetUserMediaError(new Error("boom")).kind).toBe("capture-failed");
  });
});
