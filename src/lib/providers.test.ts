import { expect, it } from "vitest";

import { defaultVoiceFor, resolveProvider, voicesFor } from "./providers.ts";

// Phase 12.3/12.4 flipped the local voice providers from "coming soon" to real.
// Pin that they are selectable AND offline-safe (both matter: available drives the
// picker, offlineSafe drives privacy enforcement).

it("local Moonshine STT and Kokoro TTS are available and offline-safe", () => {
  const stt = resolveProvider("stt", "moonshine")!;
  const tts = resolveProvider("tts", "kokoro")!;
  expect(stt.available && stt.offlineSafe && stt.kind === "local").toBe(true);
  expect(tts.available && tts.offlineSafe && tts.kind === "local").toBe(true);
});

it("voice options and defaults follow the TTS provider", () => {
  // Kokoro and OpenAI have disjoint voice tables; the picker and the reset-on-
  // switch default must track the selected provider so a voice never dangles.
  expect(defaultVoiceFor("kokoro")).toBe("af_heart");
  expect(defaultVoiceFor("openai")).toBe("alloy");
  expect(voicesFor("kokoro").map((v) => v.id)).toContain("af_heart");
  expect(voicesFor("openai").map((v) => v.id)).toContain("alloy");
  expect(voicesFor("kokoro").some((v) => v.id === "alloy")).toBe(false);
});
