# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What June is

A local-first voice agent (Tauri v2 + React 19 + TypeScript + Vite) that controls the SAPLE ecosystem by voice. Cascaded pipeline: mic -> wake word / push-to-talk -> VAD -> STT -> agent core -> TTS. `PLAN.md` is the authoritative design doc, but both its status section and README.md's status line are stale - trust git log for what has actually landed.

## Commands

```bash
npm run dev            # Vite frontend only, http://localhost:1421
npm run tauri dev      # native window (needs Rust toolchain)
npm run build          # tsc -b + vite build
npm run typecheck      # checks src + every mcp/* + agent/ tsconfig
npm run lint           # eslint (lint:fix to autofix)
npm run format:check   # prettier (format to autofix)
npm test               # vitest run (src, mcp, agent tests)
npx vitest run src/lib/wake.test.ts        # single test file
npx vitest run -t "test name"              # single test by name
npm run agent -- "do X"                    # text-only agent CLI (or no args for REPL)

# Rust side
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`predev`/`prebuild` run `scripts/fetch-models.mjs`, which stages checksum-verified ONNX voice models into `public/models/` (gitignored - binaries never enter the repo). Local voice inference runs in the webview via onnxruntime-web; assets must be served locally, never from a CDN (offline exit criterion).

Agent CLI env: `JUNE_APPROVE=allow|deny` for headless approval policy, `JUNE_WORKSPACE_ID` for the logical workspace.

Tests are colocated (`foo.test.ts` next to `foo.ts`) and run in jsdom with `src/test/setup.ts`.

## Architecture

Three layers, each swappable without touching the others:

1. **Agent core (`agent/`)** - provider-neutral `Brain` interface (`brain.ts`) with two impls: `claude-brain.ts` (via `@anthropic-ai/claude-agent-sdk`, default) and `openai-brain.ts` (OpenAI/Gemini/Ollama/LM Studio compat). `core.ts` wires a brain to its MCP capabilities and the approval gate; `cli.ts` is the text harness. Adding a provider means a new `Brain` impl, never a new loop.

2. **Capabilities = MCP servers (`mcp/`)** - `saple-bridge-control` (spawn agents/terminals/browser via saple-bridge's localhost control endpoint), `files`, `memory`, `lessons`, `automation`, `system`. June grows by adding servers, never by adding core code. Each server has its own tsconfig (all covered by `npm run typecheck`).

3. **Two UI surfaces, one session** - the always-on floating widget (`src/widget/`, the 88x88 orb window in `tauri.conf.json`) and the full app window (`src/app/`), sharing the agent session via cross-window broadcast (`src/lib/session.ts`). Voice plumbing lives in `src/lib/` (mic, vad, stt/tts, wake word, barge-in, privacy modes). `src/contract/` holds the frozen saple-bridge control contract types/validation.

The Rust shell (`src-tauri/src/`) owns the tray, window state, settings store (`settings.rs` -> `<app_data_dir>/settings.json`), scheduler/missions, native STT/TTS bridging, and the OS keychain (`keychain.rs`). **Secrets never cross the IPC boundary back to the renderer.** The bundled build ships a Node sidecar (`src-tauri/binaries/node-*.exe`) and the compiled agent (`resources/agent`, built by `scripts/bundle-agent.mjs`).

### The approval gate (do not weaken)

Dangerous actions (PLAN.md §5 classes, e.g. `spawn_agents`, `close_terminal`) are gated in the **execution layer** via the Agent SDK's `canUseTool` hook, not in the prompt - a brain physically cannot run a gated tool, and swapping brains cannot skip the gate. It **fails closed**: no approval obtainable = denied. Gate logic lives in `agent/policy.ts` (brain-independent). File writes through `mcp/files` are gated; reads are not.

### The control contract (frozen)

June talks to saple-bridge through exactly `capabilities()` / `command()` / `observe()`. Invariants to preserve: mutating commands carry a unique idempotent `request_id`; resources have stable IDs (voice labels resolve to IDs before acting); events have monotonic sequence numbers so `observe(after_sequence)` survives restarts; batch results report requested/started/failed/skipped counts (partial success is a result, not an error).

## Conventions

- Deliberate simplifications are marked with `ponytail:` comments naming the ceiling and upgrade path - keep the convention when cutting scope.
- Historical round docs and findings live in `other-files/` (see `other-files/README.md`); the current round is the highest-numbered `improvement-N.md` at the repo root.
