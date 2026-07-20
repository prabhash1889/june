import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite frontend for the Tauri shell. `clearScreen:false` keeps Rust logs visible;
// a fixed port lets tauri.conf.json point its dev server at it.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Phase 12: use onnxruntime-web's external-wasm build so Vite doesn't inline the
  // ~13MB ORT wasm into the bundle. The wasm/mjs are served from public/models/
  // (staged by scripts/fetch-models.mjs) via ort.env.wasm.wasmPaths as FULL-origin
  // URLs (ort-assets.ts / xformers.ts) - a full http URL is external to Vite, so its
  // dev server serves the /public files directly instead of tripping the "don't
  // import /public from source" guard that a root-relative path would.
  // (defaults kept explicitly - `conditions` replaces Vite's default list, and
  // dropping `browser`/`module` would mis-resolve other deps at runtime.)
  resolve: { conditions: ["module", "browser", "development|production", "onnxruntime-web-use-extern-wasm"] },
  server: {
    port: 1421,
    strictPort: true,
    // Never watch the Rust build tree: cargo holds locks on artifacts mid-build
    // and vite's watcher crashes with EBUSY (kills the whole dev server).
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022", outDir: "dist" },
});
