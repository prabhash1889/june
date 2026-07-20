// Phase 12.3/12.4 - shared transformers.js runtime config for the local voice
// stack. Local STT (local-stt.ts, Moonshine) and local TTS (local-tts.ts, Kokoro
// via kokoro-js) both run through @huggingface/transformers, which is deduped to a
// single copy, so this configures the one shared `env` singleton exactly once.
//
// Two rules that mirror the 12.1/12.2 webview-ONNX decision:
//   - the ORT wasm is served from public/models/xformers/ (staged by
//     scripts/fetch-models.mjs), never transformers' default jsdelivr CDN, so
//     inference is fully offline once the model weights are present;
//   - one wasm thread, because the Tauri webview has no cross-origin isolation
//     (no SharedArrayBuffer) - the same constraint vad.ts/wakeword.ts hit.
//
// The model weights themselves are download-on-demand from the Hugging Face hub
// (the doc's plan for the big STT/TTS models: "never bundled in the installer")
// and cached in the browser's Cache Storage, so a machine downloads them once
// while online and then runs offline. Under strict-offline with no cached model,
// the load fails and the caller falls back (or reports voice unavailable) - the
// honest degradation, identical to how a local Ollama brain needs one online pull.

import { env } from "@huggingface/transformers";

// transformers.js bundles its own jsep onnxruntime and defaults its wasm to
// jsdelivr; point it at the copies staged in /public (fetch-models) as FULL-ORIGIN
// URLs instead, so inference is offline and the `.mjs` glue is served without
// tripping Vite dev's /public import guard (same reasoning as ort-assets.ts).
const XF_BASE = "/models/xformers/";
const xfUrl = (file: string): string =>
  typeof location !== "undefined" ? new URL(XF_BASE + file, location.origin).href : XF_BASE + file;

let configured = false;

/** Point transformers.js at the staged ORT wasm and pin one thread.
 *  Idempotent; called lazily the first time a local model is loaded. */
export function configureXformers(): void {
  if (configured) return;
  configured = true;
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.wasmPaths = {
      wasm: xfUrl("ort-wasm-simd-threaded.jsep.wasm"),
      mjs: xfUrl("ort-wasm-simd-threaded.jsep.mjs"),
    };
    wasm.numThreads = 1;
  }
  // Weights come from the HF hub (cached in the browser), not a local dir.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
}

export { env };
