# Deep-Dive Review: June Application

Date: 2026-07-21

---

## Overview

June is a **local-first voice agent** built on Tauri v2 (Rust shell) + React 19 + TypeScript + Vite. It's still in early stages (Phase 0 foundations, with various improvement phases landed) but already has impressively sophisticated architecture: a resident agent process, shared mic manager, Silero/openWakeWord local models, scheduler with watch loops, privacy modes, OS keychain, tray presence, and an approval round-trip. The code quality is unusually high -- thorough comments, unit tests, defensive coercion, and careful edge-case handling.

---

## 1. Architecture & Design Concerns

### 1.1 The resident agent is a child process, not an embedded library

The agent runs as a separate Node.js child process (`agent/serve.ts`) spawned by Rust. This means every turn involves JSON serialization/deserialization across a process boundary, and crash recovery requires a full respawn. While this isolates the agent from the shell, it adds complexity that alternatives (an embedded JS runtime or a Rust-native agent SDK) would avoid. The process tree teardown (`kill_tree`) is already a known pain point with Windows `cmd` wrappers. If the agent SDK ever gets a native Rust binding, consider embedding it directly.

### 1.2 Settings write-order races between the panel and automation server

The `SETTINGS_WRITE_LOCK` mutex in `settings.rs` only serializes Rust-side writers. The automation MCP server is a separate process that writes to `settings.json` directly *without* this lock. The comment acknowledges this: "the only residual race is a voice write landing in the exact window of a panel automation edit." This is a real (if rare) race that could drop a schedule. A file-lock or a dedicated IPC channel would close this gap.

### 1.3 The scheduler tick thread blocks on agent turns

`scheduler.rs` runs `fire()` inline in the tick thread, which blocks the entire tick loop for the duration of an agent turn (potentially minutes). The `last_tick` gap-catchup mechanism (5.1) mitigates the starvation issue, but it's still a fragile design: a single long-running turn delays every other schedule, trigger, and watch by the same amount. Consider a dedicated thread pool or async task queue for unattended runs.

### 1.4 No rate limiting or budget for cloud API calls

The settings allow setting a brain provider, STT, and TTS -- but there is no per-turn or per-day cost budget. A runaway watch loop or a stuck schedule could burn through an API key's quota or incur unexpected costs. The `MAX_WATCH_ITERS` cap (30 iterations) is a start, but a user could set `everyMinutes: 1` and burn 30 API calls in 30 minutes without any dollar awareness.

---

## 2. Security & Privacy

### 2.1 Keychain secrets are read into the resident's environment

`brain_env()` reads the API key from the OS keychain and injects it into the child process's environment variables. On most OSes, `/proc/.../environ` or equivalent is world-readable by the same user, and crash dumps may capture environment strings. A more robust approach would be to pass secrets via a pipe or a temporary file with restricted permissions, though this is a common pattern so it's not a critical flaw.

### 2.2 CSP is permissive but reasonable

The Content Security Policy in `tauri.conf.json` allows `'unsafe-inline'` for styles and `'wasm-unsafe-eval'` for scripts. The `wasm-unsafe-eval` is necessary for ONNX runtime, and `unsafe-inline` for styles is common in React apps. The `connect-src` allows Hugging Face CDN for model downloads. This is tight enough for a desktop app but worth noting.

### 2.3 The privacy mode enforcement has two layers -- but the webview could theoretically bypass it

Privacy checks happen at the IPC boundary in Rust (`stt.rs`, `tts.rs`), which is the correct design. The webview also enforces it in the UI. Both agree, so this is sound. However, the local voice stack (Moonshine STT, Kokoro TTS) runs entirely in the webview via transformers.js. If there were ever a vulnerability in the webview, a malicious renderer could exfiltrate audio data. This is a desktop app (not a browser), so the attack surface is small, but it's worth noting for the threat model.

---

## 3. Code Quality & Maintainability

### 3.1 Exceptional documentation and comments

The codebase has some of the best inline documentation I've seen. Every module has a header comment explaining its purpose, design decisions, deviations from the doc, and links to PLAN.md sections. Every function with non-trivial behavior has a comment. Edges cases are called out explicitly. This is a genuine strength of the project.

### 3.2 Unit test coverage is strong but uneven

The Rust side has excellent unit tests: agent_runner, scheduler, settings, keychain, and tts all have meaningful tests. The TypeScript side has tests for transcript cleaning, schedules, voice-capture, mic, wake gate, and more. However, there are gaps:

- **No tests for the React UI components** beyond basic scaffolding (`AppWindow.test.tsx`). The `SettingsPanel.tsx` (1882 lines), `WidgetWindow.tsx`, `VoicePanel.tsx`, and `MissionBoard.tsx` have no tests.
- **No integration tests** that exercise the full pipeline (mic -> STT -> agent -> TTS -> playback).
- **No end-to-end tests** for the Tauri shell (window management, tray, hotkeys).

### 3.3 The Rust and TypeScript schedule parsers are duplicated

Both `scheduler.rs` (Rust) and `schedules.ts` (TypeScript) independently parse the same schedule/watch/trigger shapes from `settings.json`. The shapes are documented as "mirrors" of each other, but they are separate implementations with separate validation logic. A schema-sharing approach (e.g., a JSON Schema or a shared Rust struct that TS reads via a Tauri command) would eliminate drift risk.

### 3.4 `SettingsPanel.tsx` is a monolith

At 1882 lines, `SettingsPanel.tsx` is a single file that handles: STT/brain/TTS selection, API keys, privacy mode, diagnostics, memory/lessons editor, MCP server management, schedules, triggers, watches, runs history, and onboarding. This is the largest maintainability risk in the frontend. It should be split into at least 5-6 focused components.

### 3.5 Error handling is thorough but verbose

The codebase uses a pattern of wrapping every fallible operation in `map_err` and returning a `String` error. This works but loses type information. Consider a custom error enum (or `anyhow`/`thiserror` on the Rust side) so callers can pattern-match on error kinds rather than parsing strings.

### 3.6 `voice-capture.ts` has two code paths per feature

The barge monitor, endpointing, and wake listener each have a primary Silero path and a fallback RMS path. This is good for resilience, but each fallback is a separate implementation with its own `AudioContext`/`AnalyserNode` setup. This doubles the code surface for each voice feature. A stronger abstraction layer could reduce duplication.

---

## 4. Performance & Resource Usage

### 4.1 ONNX runtime model loading is eager and synchronous

The local voice models (Moonshine, openWakeWord, Kokoro) are loaded dynamically when first needed, which is fine. But the `vad.ts` and `wakeword.ts` modules are dynamically imported in `voice-capture.ts` and `wake.ts` respectively, and their model download/loading happens on the critical path of the first capture/wake start. On a slow connection or first launch, this could take 5-30 seconds. Consider warm-starting the models in the background after app launch.

### 4.2 No memory budget for the resident agent

The resident `serve.ts` process has no memory cap. A long-running session with many turns could accumulate conversation history in the agent's memory indefinitely. The conversation idle reset helps, but there's no hard limit. The `MAX_EVENTS` cap (500) on the Rust side only limits the event log, not the agent's memory.

### 4.3 The tray icon is re-rendered as a new image on every settings change

`sync_tray` calls `badged_icon` which creates a new `Image` from the raw RGBA data every time. For a settings change that happens a few times a session this is fine, but if the tray badge is updated frequently (e.g., on every tick to show a changing state), this could be wasteful. The `Icon::from_rgba` call is also done inside the `settings://changed` listener, which fires on every settings save.

### 4.4 Periodic `stat` of settings.json on every tick

The scheduler stats `settings.json` every 30 seconds to detect out-of-band writes. On an SSD this is negligible, but it's worth noting that the tick loop does a filesystem operation every 30s regardless of whether anything changed.

---

## 5. UI/UX Polish

### 5.1 The widget window is always-on-top with no way to minimize

The widget window (`main`) has `alwaysOnTop: true`, `skipTaskbar: true`, and `decorations: false`. While this is intentional for the orb design, there is no keyboard shortcut or gesture to temporarily hide it. The tray menu has "Show widget" but no "Hide widget". The window can only be dismissed by closing it (which is actually "quit" in the tray menu).

### 5.2 No loading states for model downloads

When the local voice models are being downloaded for the first time, there is no progress indicator. The `model-progress.ts` module exists but is not used in the UI paths that trigger model loading. A user who clicks "Start listening" might see a 5-10 second delay with no feedback.

### 5.3 The settings panel mixes tabs and sections

The Settings Panel has a tab-like structure but uses a `<section>` layout rather than actual tab navigation. The user scrolls through STT, brain, TTS, API keys, privacy, MCP servers, schedules, triggers, watches, runs, diagnostics, memory, and lessons -- all in one long scrollable panel. This is functional but not delightful. A proper tabbed interface or a sidebar navigation would be more navigable.

### 5.4 No visual feedback when the tray icon badge changes

The tray icon gets a red dot (muted) or amber dot (paused) badge, but there is no toast or notification to explain the state change. A user who accidentally toggles mute from the tray might not notice the badge change and wonder why the mic isn't working.

### 5.5 The CSS type scale is well-designed but limited

The custom properties (`--fs-xs` through `--fs-xl`, `--sp-1` through `--sp-5`) are a good foundation, but the spacing scale only goes up to 20px. Some layouts in the Settings panel use hardcoded values that exceed this range. The design system is not yet fully enforced.

---

## 6. Build & Dev Experience

### 6.1 The `prebuild` script runs `fetch-models.mjs` which blocks the build

The `prebuild` script runs `node scripts/fetch-models.mjs` which downloads ONNX models from Hugging Face. This means `npm run build` requires network access and can take a long time on a slow connection. The models are also fetched on `predev`, so `npm run dev` also blocks. Consider a separate `npm run fetch-models` that the user runs once, and make the build skip it if models already exist.

### 6.2 The release build bundles a Node.js binary as a sidecar

The `tauri.conf.json` references `externalBin: ["binaries/node"]` and bundles `resources/agent/` which includes the bundled agent code. This is a significant binary size cost (Node.js is ~50MB). The `bundle-agent.mjs` script esbuilds the agent code, so the agent itself is bundled, but the Node runtime is still required. This is a necessary evil for now, but it's worth noting that the final app size will be substantial.

### 6.3 The `typecheck` script runs `tsc` across 6 separate tsconfigs

Each MCP server has its own tsconfig, and they are all type-checked in sequence. This is thorough but slow. Consider a project references setup so that `tsc -b` can build them all in parallel.

### 6.4 No CI configuration visible in the repo

The `.github` directory exists but contains no CI workflow file. For a project with this many tests, a CI pipeline would be very valuable.

---

## 7. Specific Code Issues

### 7.1 `PRIVACY_MODES` is duplicated

Defined in `src/lib/privacy.ts` (TypeScript) and redefined as a const array in `src-tauri/src/lib.rs` (Rust). Like the schedule parsers, this is a drift risk if a new mode is added.

### 7.2 `MAX_AUDIT_BYTES` is 5MB -- a long session could generate this quickly

In `agent_runner.rs`, the audit log rotates at 5MB. Each `{"t":"audit",...}` line is roughly 200-500 bytes, so 5MB is about 10,000-25,000 lines. For an active session, this could be reached in a few hours. The rotation (one generation of history) is reasonable, but 5MB of log data rotated every few hours is a lot of disk I/O.

### 7.3 The `cancel_registry` in `tts.rs` uses a global `OnceLock` + `Mutex`

The barge-in cancellation uses a global `OnceLock<Mutex<HashMap<u64, (Arc<Notify>, usize)>>>`. This is a mutex on the hot path of every synthesis call. The lock is held briefly (just to clone the `Arc<Notify>`), so contention is unlikely, but a global mutable registry is not the most elegant Rust pattern. A `tokio::sync::RwLock` or a lock-free structure would be more idiomatic.

### 7.4 `enigo` dependency for dictation injection

The `enigo` crate (0.2) is used for keyboard simulation. This is a Windows-only dependency (SendInput) and is not used on other platforms. The feature gate is correct (`#[cfg(desktop)]`), but the dependency is unconditional in `Cargo.toml`. On macOS/Linux, `enigo` would be compiled but never called. Consider a platform-gated dependency.

### 7.5 The `truncate` function is duplicated

Both `agent_runner.rs` and `scheduler.rs` define a `truncate` function that caps a string by character count and appends an ellipsis. The implementations are identical. This should be a shared utility in `fsutil.rs` or a new `util.rs`.

---

## 8. Test Gaps

| Area | Status |
|------|--------|
| Rust unit tests (scheduler, settings, keychain, tts, agent_runner) | Strong |
| TypeScript unit tests (transcript, schedules, voice-capture, mic, wake gate) | Good |
| React component tests | Minimal (only `AppWindow.test.tsx` exists) |
| Integration tests (full pipeline) | None |
| E2E tests (Tauri shell) | None |
| Accessibility tests | None |
| Performance benchmarks | None |

---

## Summary: What to Address First

**High priority (real bugs / reliability):**
1. Settings write race between the panel and automation MCP server
2. No per-turn or per-day cost budget for cloud API calls
3. Scheduler tick thread blocking on long agent turns

**Medium priority (maintainability):**
4. Split the 1882-line `SettingsPanel.tsx` into focused components
5. Share schedule/watch/trigger schema between Rust and TypeScript (eliminate duplicated parsers)
6. Warm-start local ONNX models in the background rather than on first use
7. Share the `truncate` utility between Rust modules

**Lower priority (polish):**
8. Add component tests for the React UI
9. Show download progress when fetching local models
10. Add a tabbed or sidebar navigation for the settings panel
11. Make the widget window hidable (not just closable)
12. Add CI configuration

The codebase is remarkably well-engineered for its phase. The architecture decisions (resident agent, shared mic, privacy layers, atomic settings writes) are all sound, and the documentation sets a high bar that most projects would benefit from matching.