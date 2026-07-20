// Phase 12.4 - local text-to-speech in the webview via Kokoro-82M (kokoro-js),
// behind the same seam as the cloud OpenAI path (tts.ts routes here when the
// selected TTS provider is local). kokoro-js runs the ONNX model through
// transformers.js on the wasm staged by fetch-models.mjs, and phonemizes text
// with the pure-JS `phonemizer` (Apache-2.0) - no espeak-ng, so the GPL path the
// doc flagged as a risk is avoided outright.
//
// The sentence streamer (tts.ts SpeechQueue) is reused unchanged: it still enqueues
// one sentence at a time; each sentence is synthesized here to a WAV clip the
// <audio> element plays. Imported dynamically by tts.ts so kokoro-js/transformers
// never enter the cloud-only path or the unit tests.

import { KokoroTTS } from "kokoro-js";

import { clearModelProgress, reportModelProgress, type XformersProgress } from "./model-progress.ts";
import { configureXformers } from "./xformers.ts";

export const DEFAULT_TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";

// One warm model per id; a failed load is evicted so the next turn retries.
const models = new Map<string, Promise<KokoroTTS>>();

function getModel(model: string): Promise<KokoroTTS> {
  const id = model || DEFAULT_TTS_MODEL;
  let p = models.get(id);
  if (!p) {
    configureXformers();
    // q8: ~86MB, the quality/latency sweet spot for CPU wasm (fp32 is ~330MB).
    // First run downloads the weights mid-SpeechQueue; the widget shows the
    // progress (improvement-5 P0.5) instead of sitting mute in "Speaking…".
    p = KokoroTTS.from_pretrained(id, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (info: XformersProgress) => reportModelProgress("voice model", info),
    });
    void p.then(
      () => clearModelProgress(),
      () => {
        models.delete(id);
        clearModelProgress();
      },
    );
    models.set(id, p);
  }
  return p;
}

/** Pick a valid Kokoro voice: the user's choice if the model actually has it,
 *  else the default. An OpenAI voice id (e.g. "alloy") left over from a provider
 *  switch simply falls back rather than erroring. Pure, given the model's voice
 *  table - the runnable check for the voice guard. */
export function pickKokoroVoice(voice: string | undefined, available: Iterable<string>): string {
  const set = new Set(available);
  return voice && set.has(voice) ? voice : DEFAULT_KOKORO_VOICE;
}

/** Synthesize one chunk of text locally to WAV bytes the webview can play as-is
 *  (mime audio/wav). Empty text yields no audio, matching the cloud contract. */
export async function synthesizeLocal(text: string, voice: string | undefined, model: string): Promise<Uint8Array> {
  if (!text.trim()) return new Uint8Array();
  const tts = await getModel(model);
  const v = pickKokoroVoice(voice, Object.keys(tts.voices));
  // v is validated against the model's own voice table above; `never` bridges to
  // kokoro's `keyof typeof VOICES` literal type without re-stating the union.
  const audio = await tts.generate(text, { voice: v as never });
  return new Uint8Array(audio.toWav());
}
