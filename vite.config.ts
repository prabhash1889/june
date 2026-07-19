import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite frontend for the Tauri shell. `clearScreen:false` keeps Rust logs visible;
// a fixed port lets tauri.conf.json point its dev server at it.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    // Never watch the Rust build tree: cargo holds locks on artifacts mid-build
    // and vite's watcher crashes with EBUSY (kills the whole dev server).
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022", outDir: "dist" },
});
