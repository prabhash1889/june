import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite frontend for the Tauri shell. `clearScreen:false` keeps Rust logs visible;
// a fixed port lets tauri.conf.json point its dev server at it.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
});
