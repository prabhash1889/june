// Phase 12 local-voice model fetch (download-on-demand, checksum-verified).
//
// June's local voice stack runs its ONNX models in the webview via
// onnxruntime-web, so the model + wasm assets must be served locally (never a
// CDN) for the "network disabled" offline exit criterion. This script stages
// them into public/models/ (gitignored - binaries never enter the repo), which
// Vite copies verbatim into the build. Run once after `npm install`; `predev`
// and `prebuild` call it, and it is a fast no-op when every file is present and
// its checksum matches.
//
// ponytail: the Phase 12 doc asks for runtime download-on-demand with a progress
// UI. That belongs to the large STT/TTS models (245MB) where the wait is
// user-visible; the VAD + wake models here total ~6MB, so a build-time
// checksum-verified stage is the honest, simplest cut. The runtime progress UI
// lands with 12.3's big models. Deviation noted in improvement-4.md.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "models");
const nm = join(root, "node_modules");

// The Silero model + audio worklet (12.1) are FETCHed at runtime by vad-web, so
// they belong in /public. The onnxruntime wasm loaders (for our 1.27 ORT and the
// one transformers.js bundles) are NOT staged here: they are imported as Vite
// `?url` assets (src/lib/ort-assets.ts, src/lib/xformers.ts) so Vite serves the
// `.mjs` loader through the module graph in both dev and prod - a /public copy
// fails Vite dev's "don't import public files from source" guard.
const copies = [
  ["@ricky0123/vad-web/dist/silero_vad_v5.onnx", "vad/silero_vad_v5.onnx"],
  ["@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", "vad/vad.worklet.bundle.min.js"],
  // onnxruntime-web wasm loader (1.27) for VAD + wake. Both the .wasm binary and the
  // .mjs glue are staged; ort-assets.ts points ORT at them as full-origin URLs so
  // the .mjs `import()` is served without tripping Vite dev's /public guard.
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort/ort-wasm-simd-threaded.wasm"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort/ort-wasm-simd-threaded.mjs"],
  // transformers.js (local STT/TTS) bundles its own jsep onnxruntime; stage its wasm
  // + mjs loader too (xformers.ts points env.backends.onnx.wasm.wasmPaths here).
  ["@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm", "xformers/ort-wasm-simd-threaded.jsep.wasm"],
  ["@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs", "xformers/ort-wasm-simd-threaded.jsep.mjs"],
];

// openWakeWord (12.2): the shared melspectrogram + speech-embedding models and
// the "hey jarvis" classifier (Apache-2.0, dscripka/openWakeWord v0.5.1). The
// classifier is the only per-phrase file - a trained "hey june" model drops in
// beside it behind the same seam, no code change. Checksums pin the supply chain.
const OWW = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const downloads = [
  {
    url: `${OWW}/melspectrogram.onnx`,
    dest: "wake/melspectrogram.onnx",
    sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
  },
  {
    url: `${OWW}/embedding_model.onnx`,
    dest: "wake/embedding_model.onnx",
    sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
  },
  {
    url: `${OWW}/hey_jarvis_v0.1.onnx`,
    dest: "wake/hey_jarvis_v0.1.onnx",
    sha256: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
  },
];

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

let staged = 0;
for (const [from, to] of copies) {
  const dest = join(out, to);
  if (existsSync(dest)) continue;
  await ensureDir(dest);
  await copyFile(join(nm, from), dest);
  staged++;
  console.log(`copied  ${to}`);
}

for (const { url, dest, sha256: want } of downloads) {
  const path = join(out, dest);
  if (existsSync(path) && (await sha256(path)) === want) continue;
  await ensureDir(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${dest}: got ${got}, want ${want}`);
  await writeFile(path, buf);
  staged++;
  console.log(`fetched ${dest}`);
}

console.log(staged === 0 ? "models: all present, checksums OK" : `models: staged ${staged} file(s)`);
