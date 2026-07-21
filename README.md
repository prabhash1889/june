# June

A local-first voice agent that controls the SAPLE ecosystem (and more) by voice. Speak to the
floating orb and June transcribes, reasons, and acts through a set of capabilities - reading
files, driving saple-bridge, running scheduled missions - with dangerous actions gated behind
an approval you confirm out loud or on screen.

Built with **Tauri v2** (Rust shell) + **React 19 + TypeScript + Vite**, mirroring the
conventions used by `saple-bridge` and `artemis-desktop` in this workspace. Windows-first today
(dictation uses `SendInput`, the `system` capability shells to PowerShell). See [`PLAN.md`](./PLAN.md)
for the full design; for what has actually shipped, trust the git log rather than PLAN.md's
status header.

**Status:** functional. Full voice pipeline (wake word, VAD, barge-in, push-to-talk, dictation,
quick capture), a resident agent with two interchangeable brains, six built-in MCP capabilities,
missions, schedules/watches/triggers with a run ledger, OS-keychain secrets, a real tray menu,
and packaged MSI/NSIS installers with a signed auto-updater.

## How it works

A cascaded voice pipeline: **mic -> wake word / push-to-talk -> VAD -> STT -> agent core -> TTS**.
Three layers, each swappable without touching the others:

1. **Agent core (`agent/`)** - a provider-neutral `Brain` interface with two implementations:
   `claude-brain.ts` (via `@anthropic-ai/claude-agent-sdk`, default) and `openai-brain.ts`
   (OpenAI / Gemini / Ollama / LM Studio compatible). Adding a provider is a new `Brain`, never
   a new loop.
2. **Capabilities = MCP servers (`mcp/`)** - `saple-bridge-control`, `files`, `memory`,
   `lessons`, `automation`, `system`. June grows by adding a server, not by adding core code.
3. **Two UI surfaces, one session** - the always-on floating orb widget (`src/widget/`) and the
   full app window (`src/app/`), sharing one agent session over a cross-window broadcast
   (`src/lib/session.ts`).

### Safety model

- **Approval gate in the execution layer.** Dangerous actions are gated via the Agent SDK's
  `canUseTool` hook (`agent/policy.ts`), not in the prompt - a brain physically cannot run a
  gated tool, and swapping brains cannot skip the gate. It **fails closed**: no approval
  obtainable means denied.
- **Privacy modes.** Standard vs. Strict offline, enforced at the IPC boundary in Rust, so
  editing `settings.json` cannot bypass a mode. Under Strict offline only local, no-network
  capabilities and the local voice stack (Moonshine STT, Kokoro TTS) run.
- **Secrets never cross IPC back to the renderer.** Provider API keys live in the OS keychain.
- **Path containment** for the files capability: every path is resolved (and realpath-checked
  against symlink escapes) inside a single configured root.

## Develop

```bash
npm install
npm run dev          # Vite frontend only, http://localhost:1421 (browser)
npm run tauri dev    # native window (requires Rust + Tauri CLI)
npm run build        # typecheck + Vite production build
npm run tauri build  # packaged MSI + NSIS installers
```

`predev`/`prebuild` run `scripts/fetch-models.mjs`, which stages checksum-verified ONNX voice
models into `public/models/` (gitignored - binaries never enter the repo). Local voice
inference runs in the webview via `onnxruntime-web`; assets are always served locally, never
from a CDN.

Text-only agent harness (no voice, no Tauri):

```bash
npm run agent -- "do X"    # one-shot, or no args for a REPL
# JUNE_APPROVE=allow|deny sets headless approval policy; JUNE_WORKSPACE_ID picks the workspace
```

## Checks

```bash
npm run typecheck    # src + every mcp/* + agent/ tsconfig
npm run lint
npm run format:check
npm test             # vitest (src, mcp, agent)

cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Tests are colocated (`foo.test.ts` next to `foo.ts`) and run in jsdom.

## Layout

- `src/` - React frontend: `widget/` (orb), `app/` (full window), `voice/` (pipeline UI),
  `lib/` (mic, VAD, STT/TTS, wake word, barge-in, privacy), `contract/` (frozen saple-bridge
  control contract).
- `agent/` - resident agent core, `Brain` implementations, approval policy, CLI harness.
- `mcp/` - the six MCP capability servers, each with its own tsconfig.
- `src-tauri/src/` - Rust shell: tray, window state, `settings.rs` (JSON store at
  `<app_data_dir>/settings.json`), `scheduler.rs` (schedules/missions/watches), native STT/TTS
  bridging, `keychain.rs` (OS keychain for provider keys - no secret crosses IPC).
- `scripts/` - `fetch-models.mjs` (stage voice models), `bundle-agent.mjs` (compile the agent
  for the packaged build).
