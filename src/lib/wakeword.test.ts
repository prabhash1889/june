import { describe, expect, it, vi } from "vitest";

import { WakeModel, type WakeRunners } from "./wakeword.ts";

// A chunk of raw 16kHz audio (1280 samples = 80ms) is openWakeWord's accumulation
// unit. Fakes stand in for the ONNX sessions: the melspec model returns exactly 8
// mel frames per chunk (the real model's behaviour), the embedding model a 96-dim
// vector, the classifier a fixed score - so the buffer/stepping accounting is what
// is under test, not ONNX numerics.
const CHUNK = 1280;
const MEL_BINS = 32;

function fakeRunners(score = 0.9): WakeRunners & {
  mel: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  classify: ReturnType<typeof vi.fn>;
} {
  const mel = vi.fn(async (_samples: Float32Array) => new Float32Array(8 * MEL_BINS).fill(1));
  const embed = vi.fn(async (_window: Float32Array) => new Float32Array(96).fill(0.5));
  const classify = vi.fn(async (_features: Float32Array) => score);
  return { mel, embed, classify };
}

function frame(n: number, value: number): Float32Array {
  return new Float32Array(n).fill(value);
}

describe("WakeModel streaming", () => {
  it("scales audio to int16 magnitude before the melspectrogram model", async () => {
    const r = fakeRunners();
    const model = new WakeModel(r);
    await model.feed(frame(CHUNK, 0.5));
    expect(r.mel).toHaveBeenCalledTimes(1);
    const samples = r.mel.mock.calls[0][0] as Float32Array;
    expect(samples[0]).toBeCloseTo(0.5 * 32767, 1);
  });

  it("only runs the melspectrogram on whole 80ms chunks, stashing the remainder", async () => {
    const r = fakeRunners();
    const model = new WakeModel(r);
    // 512-sample frames like Silero emits: 512 + 512 = 1024 (< chunk, no run),
    // then 512 more crosses 1280 -> exactly one run, 256 samples held over.
    expect(await model.feed(frame(512, 0.1))).toBeNull();
    expect(await model.feed(frame(512, 0.1))).toBeNull();
    await model.feed(frame(512, 0.1));
    expect(r.mel).toHaveBeenCalledTimes(1);
  });

  it("feeds the embedding model a 76x32 window and the classifier 16x96, once 16 embeddings exist", async () => {
    const r = fakeRunners(0.9);
    const model = new WakeModel(r);

    // 76 mel frames arrive after 10 chunks (80 frames) -> first embedding. One
    // embedding per chunk thereafter; the 16th (and first score) is chunk 25.
    let score: number | null = null;
    for (let i = 0; i < 25; i++) score = await model.feed(frame(CHUNK, 0.2));

    expect(score).toBe(0.9);
    // Embedding windows are always a full 76 frames of 32 bins.
    expect(r.embed).toHaveBeenCalled();
    expect((r.embed.mock.calls[0][0] as Float32Array).length).toBe(76 * MEL_BINS);
    // The classifier scores exactly the last 16 embeddings.
    expect(r.classify).toHaveBeenCalledTimes(1);
    expect((r.classify.mock.calls[0][0] as Float32Array).length).toBe(16 * 96);
  });

  it("returns null (warming up) before 16 embeddings have accumulated", async () => {
    const r = fakeRunners();
    const model = new WakeModel(r);
    for (let i = 0; i < 24; i++) {
      expect(await model.feed(frame(CHUNK, 0.2))).toBeNull();
    }
    expect(r.classify).not.toHaveBeenCalled();
  });
});
