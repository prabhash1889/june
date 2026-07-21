import { beforeEach, expect, it, vi } from "vitest";

// Phase 12.3/12.4: transcribe()/synthesize() route to on-device inference when the
// selected provider is local, and to the Rust cloud command otherwise. These pin
// that seam without loading transformers.js/kokoro-js (the local modules are
// mocked), so the routing is provable headlessly.

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const transcribeLocal = vi.hoisted(() => vi.fn());
vi.mock("./local-stt.ts", () => ({ transcribeLocal }));

const synthesizeLocal = vi.hoisted(() => vi.fn());
vi.mock("./local-tts.ts", () => ({ synthesizeLocal }));

import { transcribe } from "./stt.ts";
import { synthesize } from "./tts.ts";

beforeEach(() => {
  invoke.mockReset();
  transcribeLocal.mockReset();
  synthesizeLocal.mockReset();
});

it("transcribe routes a local STT provider to on-device inference", async () => {
  transcribeLocal.mockResolvedValue("hello there");
  const out = await transcribe(new Uint8Array([1, 2]), "audio/webm", {
    provider: "moonshine",
    model: "onnx-community/moonshine-base-ONNX",
  });
  expect(out).toBe("hello there");
  expect(transcribeLocal).toHaveBeenCalledWith(expect.any(Uint8Array), "onnx-community/moonshine-base-ONNX");
  expect(invoke).not.toHaveBeenCalled();
});

it("transcribe routes a cloud STT provider (or no choice) to Rust", async () => {
  invoke.mockResolvedValue("cloud text");
  expect(await transcribe(new Uint8Array([1]), "audio/webm", { provider: "openai", model: "whisper-1" })).toBe("cloud text");
  expect(await transcribe(new Uint8Array([1]), "audio/webm")).toBe("cloud text"); // wake fallback, no choice
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith("transcribe", expect.objectContaining({ mime: "audio/webm" }));
  expect(transcribeLocal).not.toHaveBeenCalled();
});

it("synthesize routes local TTS to on-device Kokoro and reports wav", async () => {
  synthesizeLocal.mockResolvedValue(new Uint8Array([9, 9]));
  const { bytes, mime } = await synthesize("hi", { provider: "kokoro", model: "onnx-community/Kokoro-82M-v1.0-ONNX", voice: "af_heart" });
  expect(mime).toBe("audio/wav");
  expect(bytes).toEqual(new Uint8Array([9, 9]));
  // 4th arg is the optional barge-in AbortSignal (3.11), undefined for a one-off call.
  expect(synthesizeLocal).toHaveBeenCalledWith("hi", "af_heart", "onnx-community/Kokoro-82M-v1.0-ONNX", undefined);
  expect(invoke).not.toHaveBeenCalled();
});

it("synthesize routes cloud TTS to Rust and reports mp3", async () => {
  invoke.mockResolvedValue([1, 2, 3]);
  const { bytes, mime } = await synthesize("hi", { provider: "openai", model: "tts-1", voice: "alloy" });
  expect(mime).toBe("audio/mpeg");
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(invoke).toHaveBeenCalledWith("synthesize", { text: "hi", voice: "alloy", model: "tts-1" });
  expect(synthesizeLocal).not.toHaveBeenCalled();
});
