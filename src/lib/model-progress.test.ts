// The aggregate download row (improvement-7 1.5): per-file bytes sum across
// models, sidecar files are ignored, and the row clears only when every loader
// settled.
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearModelProgress,
  formatModelProgress,
  MODEL_PROGRESS_EVENT,
  type ModelProgress,
  reportModelProgress,
} from "./model-progress.ts";

const MB = 1048576;

describe("model-progress aggregation", () => {
  let events: ModelProgress[] = [];
  const last = () => events[events.length - 1];

  beforeEach(() => {
    events = [];
    clearModelProgress(); // reset module state from any prior test
    events = []; // drop the reset's null dispatch
    window.addEventListener(MODEL_PROGRESS_EVENT, (e) => {
      events.push((e as CustomEvent<ModelProgress>).detail);
    });
  });

  it("sums bytes across files and models into one row", () => {
    reportModelProgress("speech-to-text model", {
      status: "progress",
      file: "encoder.onnx",
      loaded: 10 * MB,
      total: 100 * MB,
    });
    expect(last()).toMatchObject({ label: "speech-to-text model", loadedBytes: 10 * MB, totalBytes: 100 * MB, pct: 10 });

    reportModelProgress("voice model", { status: "progress", file: "model.onnx", loaded: 5 * MB, total: 20 * MB });
    // Two active models -> generic label, summed bytes.
    expect(last()).toMatchObject({ label: "on-device voice models", loadedBytes: 15 * MB, totalBytes: 120 * MB });
    expect(formatModelProgress(last()!)).toBe("15/120 MB");
  });

  it("ignores sidecar (non-onnx) files", () => {
    reportModelProgress("speech-to-text model", { status: "progress", file: "tokenizer.json", loaded: 1, total: 2 });
    expect(events).toHaveLength(0);
  });

  it("clears one model's share on ready and the row once all settled", () => {
    reportModelProgress("speech-to-text model", { status: "progress", file: "a.onnx", loaded: 1 * MB, total: 2 * MB });
    reportModelProgress("voice model", { status: "progress", file: "b.onnx", loaded: 3 * MB, total: 4 * MB });
    reportModelProgress("speech-to-text model", { status: "ready" });
    expect(last()).toMatchObject({ label: "voice model", loadedBytes: 3 * MB, totalBytes: 4 * MB });
    clearModelProgress("voice model"); // e.g. a failed load never fires "ready"
    expect(last()).toBeNull();
  });
});
