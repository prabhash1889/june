import { describe, expect, it } from "vitest";

import { WakeGate, wakeThreshold } from "./wake-gate.ts";

describe("wakeThreshold", () => {
  it("maps sensitivity 0..1 to a 0.30..0.70 score threshold, 0.50 at the default", () => {
    expect(wakeThreshold(0)).toBeCloseTo(0.3);
    expect(wakeThreshold(0.5)).toBeCloseTo(0.5);
    expect(wakeThreshold(1)).toBeCloseTo(0.7);
  });

  it("clamps out-of-range sensitivity", () => {
    expect(wakeThreshold(-1)).toBeCloseTo(0.3);
    expect(wakeThreshold(2)).toBeCloseTo(0.7);
  });
});

describe("WakeGate", () => {
  it("fires once per crossing and re-arms only after the score falls under the release level", () => {
    const gate = new WakeGate(0.5, 0.3);
    // Rising through the threshold fires exactly once.
    expect(gate.push(0.4, true)).toBe(false);
    expect(gate.push(0.6, true)).toBe(true);
    // Still-high scores do not re-fire (disarmed).
    expect(gate.push(0.9, true)).toBe(false);
    expect(gate.push(0.55, true)).toBe(false);
    // Dropping under the release re-arms; the next crossing fires again.
    expect(gate.push(0.2, true)).toBe(false);
    expect(gate.push(0.7, true)).toBe(true);
  });

  it("never fires while Silero reports no speech, even above threshold", () => {
    const gate = new WakeGate(0.5);
    expect(gate.push(0.99, false)).toBe(false);
    // Once speech is present the same score fires.
    expect(gate.push(0.99, true)).toBe(true);
  });
});
