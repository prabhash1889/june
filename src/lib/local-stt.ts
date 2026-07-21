// Phase 12.3 - local speech-to-text in the webview via Moonshine (transformers.js
// ASR pipeline), behind the same seam as the cloud Whisper path (stt.ts routes to
// here when the selected STT provider is local). Runs entirely on-device through
// onnxruntime-web on the wasm staged by fetch-models.mjs, so once the model is
// cached the transcription never leaves the machine.
//
// Moonshine v2 is the doc's streaming primary; this first cut runs it in batch
// mode over the whole recorded clip (streaming interim transcripts are Phase 12.6).
// A different transformers.js-compatible ASR repo (a Whisper or Parakeet ONNX
// build) can be typed into the model field and loaded verbatim - the model id is
// the only per-engine seam, exactly like the wake classifier in wakeword.ts.
//
// Imported dynamically by stt.ts so transformers.js (and its wasm) never enter the
// cloud-only path or the unit tests.

import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

import { clearModelProgress, reportModelProgress, type XformersProgress } from "./model-progress.ts";
import { configureXformers } from "./xformers.ts";

/** Moonshine base: the doc's primary. The registry offers tiny as the faster
 *  toggle; any ASR repo id the user types is loaded as-is. */
export const DEFAULT_STT_MODEL = "onnx-community/moonshine-base-ONNX";
const TARGET_RATE = 16_000; // every supported ASR model expects 16kHz mono

// One warm pipeline per model id (loading downloads/compiles the ONNX graph, so
// it must happen once, not per utterance). A failed load is evicted so the next
// turn retries rather than caching a rejection forever.
const pipes = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

const STT_PROGRESS_LABEL = "speech-to-text model";

function getPipe(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  const id = model || DEFAULT_STT_MODEL;
  let p = pipes.get(id);
  if (!p) {
    configureXformers();
    // The pipeline() overloads produce a union too large for tsc to represent;
    // this call site is the one place it's constructed, so narrow it here.
    p = pipeline("automatic-speech-recognition", id, {
      device: "wasm",
      // First run downloads ~190MB of weights; the widget shows the progress
      // (improvement-5 P0.5) instead of hanging in "Transcribing…".
      progress_callback: (info: XformersProgress) => reportModelProgress(STT_PROGRESS_LABEL, info),
    }) as unknown as Promise<AutomaticSpeechRecognitionPipeline>;
    void p.then(
      () => clearModelProgress(STT_PROGRESS_LABEL),
      () => {
        pipes.delete(id);
        clearModelProgress(STT_PROGRESS_LABEL);
      },
    );
    pipes.set(id, p);
  }
  return p;
}

/** Warm the ASR model (improvement-7 1.5): download + compile it now so picking
 *  a local provider doesn't make the FIRST TURN pay the multi-minute download.
 *  Resolves when the pipeline is ready; rejects if the load failed. */
export function preloadLocalStt(model: string): Promise<void> {
  return getPipe(model).then(() => undefined);
}

/** Decode a compressed clip (webm/opus, mp4, ...) straight from MediaRecorder to
 *  mono 16kHz PCM, the input every ASR model wants. Uses the platform's own audio
 *  decoder + resampler (OfflineAudioContext) so we don't reinvent either. */
export async function decodePcm16k(audio: Uint8Array): Promise<Float32Array> {
  // decodeAudioData consumes an ArrayBuffer; copy out of the (possibly larger,
  // shared) backing buffer so only this clip's bytes are decoded.
  const bytes = audio.slice();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes.buffer);
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
    // Rendering through a 1-channel 16kHz context downmixes and resamples in one
    // pass - the source's channels fold into the mono destination.
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    void ctx.close();
  }
}

/** Transcribe a captured clip locally. `model` is the ASR repo id (empty = the
 *  Moonshine default). Returns the trimmed transcript (may be empty for silence),
 *  matching the cloud path's contract so callers don't branch. */
export async function transcribeLocal(audio: Uint8Array, model: string): Promise<string> {
  const samples = await decodePcm16k(audio);
  const pipe = await getPipe(model);
  const out = await pipe(samples);
  const text = Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text;
  return (text ?? "").trim();
}
