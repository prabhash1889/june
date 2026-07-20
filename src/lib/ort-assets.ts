// Points onnxruntime-web (1.27, used by VAD + wake) at its wasm loader, staged in
// /public by fetch-models, as FULL-ORIGIN URLs.
//
// Why full-origin and not "/models/ort/...": ORT loads its wasm by `import()`-ing
// the sibling `.mjs` glue. A root-relative path makes Vite dev resolve that import
// into /public and refuse it ("This file is in /public ... should not be imported
// from source code"), so VAD/wake failed to start under `vite dev` (prod copies
// /public as-is, which is why a build-only check missed it). A full http URL is
// external to Vite's resolver, so it serves the /public file directly - dev and
// prod, fully offline (no CDN). `location.origin` is the dev server in dev and the
// Tauri app origin in the packaged build.
//
// onnxruntime-web's `env.wasm.wasmPaths` accepts an object keyed by file type
// ({ mjs, wasm }); handing it explicit URLs stops it constructing its own path.

const ORT_BASE = "/models/ort/";
const url = (file: string): string =>
  typeof location !== "undefined" ? new URL(ORT_BASE + file, location.origin).href : ORT_BASE + file;

export const ORT_WASM_PATHS = {
  wasm: url("ort-wasm-simd-threaded.wasm"),
  mjs: url("ort-wasm-simd-threaded.mjs"),
} as const;
