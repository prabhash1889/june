import { expect, it, vi } from "vitest";

// The Kokoro voice guard (12.4): a valid voice is kept, anything else (e.g. an
// OpenAI voice left over from a provider switch) falls back to the default, so a
// stale settings value never errors the synthesis. kokoro-js/transformers are
// mocked so this loads without the real model libraries.
vi.mock("kokoro-js", () => ({ KokoroTTS: {} }));
vi.mock("./xformers.ts", () => ({ configureXformers: () => {}, env: {} }));

import { DEFAULT_KOKORO_VOICE, pickKokoroVoice } from "./local-tts.ts";

const AVAILABLE = ["af_heart", "af_bella", "am_michael"];

it("keeps a voice the model actually has", () => {
  expect(pickKokoroVoice("am_michael", AVAILABLE)).toBe("am_michael");
});

it("falls back to the default for an unknown or missing voice", () => {
  expect(pickKokoroVoice("alloy", AVAILABLE)).toBe(DEFAULT_KOKORO_VOICE); // leftover OpenAI voice
  expect(pickKokoroVoice(undefined, AVAILABLE)).toBe(DEFAULT_KOKORO_VOICE);
  expect(pickKokoroVoice("", AVAILABLE)).toBe(DEFAULT_KOKORO_VOICE);
});
