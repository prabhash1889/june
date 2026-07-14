# June - Voice-Driven General-Purpose Agent

> A local-first voice agent that controls the SAPLE ecosystem (and more) by voice.
> Tell June what to do; it does it, answers back, and stays out of your way.

**Status:** Phase 0 complete
**Owner:** prabhash1889
**Repo:** `SAPLE-ALL/june` (standalone; sibling of `saple-bridge`, `saple-mcp`, `artemis`, `sentry`)
**Last updated:** 2026-07-14

---

## 1. What June is

June is a standalone desktop companion that listens to spoken commands, runs them through a Claude-powered agent loop, executes them against a set of pluggable capabilities (starting with saple-bridge), and speaks the result back. It is **not** a single-purpose tool: capabilities are MCP servers, so June grows by adding servers, never by rewriting the core.

Concrete things a user should be able to say on day one of the saple integration:

- "Open five Claude agents and four Codex agents in this workspace."
- "Give the third agent this task: refactor the auth module."
- "Open a browser and go to the docs."
- "Close the terminal that's running the failing build."
- "What's the status of the swarm?"

And things June should grow into (just more MCP servers): calendar, email, files, home automation, web research.

### The two forms (both required)

June ships as **one app with two faces**, sharing a single agent core and settings store:

1. **Widget form** - an always-available, high-quality floating surface (not a tiny pill). Rich enough to show live transcription, what June is doing, and quick results, while staying unobtrusive. **Full visual/interaction spec is deferred to Phase 6, which will ask the user for details** (size, docking, transparency, expand/collapse behavior, animation language, what it shows at rest vs. active).
2. **Application form** - the full window: conversation history, settings, model pickers, capability (MCP) management, agent/session monitor, logs, and diagnostics.

Both forms drive the same agent session, so a command started in the widget is visible in the app and vice versa.

---

## 2. Architecture at a glance

June is a **cascaded voice pipeline** wrapped around a **provider-pluggable agent core**. The brain is not tied to any one vendor: Claude is the default, but OpenAI GPT, Google Gemini, and local models (Ollama / LM Studio) are first-class choices too. Cascaded (STT → agent → TTS) is chosen over speech-to-speech because it lets June pair any brain with arbitrary MCP tools, is debuggable, and lets the user swap any stage's provider - speech-to-speech would lock the brain to one vendor.

```
                          ┌────────────────────────────────────────────┐
  [mic] → wake word / PTT │  Voice pipeline                            │
        → VAD (endpoint)  │   STT  →  Agent core  →  TTS               │
                          └───┬───────────┬──────────────┬─────────────┘
                              │           │              │
                    STT provider     Agent core -     TTS provider
                    (local/cloud)    any LLM brain    (local/cloud)
                                          │
                          ┌───────────────┼─────────────────────────────┐
                          │  Capabilities (MCP servers) - pluggable      │
                          │   • saple-bridge-control  (spawn/terminal/browser)
                          │   • saple-memory          (tasks/agents/runs) 8765
                          │   • artemis (wrapped)     (headless missions) 8770
                          │   • future: calendar, email, files, web...   │
                          └──────────────────────────────────────────────┘
                              │
            ┌─────────────────┴──────────────────┐
            │  Two UI surfaces (shared core)      │
            │   • Widget form   • Application form │
            └─────────────────────────────────────┘
```

### Core design decisions

| Decision | Choice | Why |
|---|---|---|
| Pipeline | Cascaded STT → agent → TTS | Provider-agnostic brain + tools; debuggable; every stage swappable |
| Brain | Provider-pluggable agent loop (TypeScript): Claude default, plus OpenAI, Gemini, and local models | User chooses the brain like any other stage; one tool-calling loop + MCP client works across providers |
| Extensibility | Every capability is an MCP server | Add a server, not a plugin system |
| Bridge control | New localhost control endpoint in saple-bridge, wrapped as an MCP server | saple-bridge has no external intake today; this is the one thing that must be added there |
| Model choice | User-selectable per stage (STT / brain / TTS), local **or** API, per provider | Core product requirement |
| Packaging | Standalone Tauri app (Rust + web UI) with tray presence | Must outlive and launch saple-bridge; grows beyond saple |
| Activation | Push-to-talk first, wake word later | PTT is zero-false-trigger and trivial; wake word is polish |

### Why standalone, not a saple-bridge pane

June must be able to launch and control saple-bridge (including starting it), will accumulate non-saple capabilities, and should keep saple-bridge's surface area to just the one generic control endpoint. A separate app keeps that boundary clean.

---

## 3. The model-choice system (a first-class feature)

Every stage of the pipeline and the brain itself is configurable. This is central, not an afterthought.

| Stage | Local options | API options | Notes |
|---|---|---|---|
| **STT** | faster-whisper, NVIDIA Parakeet, Moonshine (streaming) | Deepgram, AssemblyAI, OpenAI | Local default for privacy; short commands tolerate small models |
| **Brain** | Ollama / LM Studio (Llama, Qwen, DeepSeek - any tool-calling model) | Claude (`claude-opus-4-8` default; Fable 5, Sonnet 5, Haiku), OpenAI GPT, Google Gemini, any OpenAI-compatible endpoint | All first-class; the model must support tool calling to drive capabilities |
| **TTS** | Kokoro-82M (default), Piper (fastest) | ElevenLabs, edge-tts, OpenAI | Kokoro = best local quality/latency; stream sentence-by-sentence |
| **Wake word** | openWakeWord (custom "Hey June") | Porcupine (commercial) | Optional; PTT works without it |
| **VAD** | Silero VAD | - | End-of-utterance + barge-in |

**Provider abstraction:** each stage sits behind an interface (`SttProvider`, `Brain`, `TtsProvider`) so adding a provider is implementing one interface plus a settings entry. Users pick provider + model + local/API in settings; API keys are stored in the OS keychain (never in config files), mirroring saple-bridge's keychain convention.

**Brain abstraction specifically:** June runs **one agent loop** (tool-calling loop + MCP client) over a unified provider layer, so every brain - Claude, GPT, Gemini, or a local model - drives the same capabilities through the same code path. Adding a brain provider is a config entry, not a new loop. Claude gets the deepest integration (Agent SDK niceties like permission hooks); every other provider runs through the same loop with equivalent confirmation gates. Models that cannot do tool calling are rejected at selection time with a clear message rather than failing mid-command.

---

## 4. Settings & functionality surface (Application form)

- **Models** - pick STT / brain / TTS provider + model + local/API for each; test button per stage.
- **API keys** - per provider, OS keychain backed, with connection test.
- **Activation** - push-to-talk hotkey, wake word on/off + phrase, VAD sensitivity, barge-in on/off.
- **Capabilities (MCP)** - list connected MCP servers, add/remove, per-server enable, health status, tool inspector.
- **Voice** - TTS voice pick, rate, volume; spoken-confirmation policy for destructive actions.
- **Agent** - model, effort level, system-prompt tuning, session memory on/off, max concurrent agents.
- **Widget** - position, size, opacity, docking, at-rest vs. active behavior (details gathered in Phase 6).
- **Privacy** - local-only mode toggle (forces local STT/TTS/brain, blocks cloud), transcript retention.
- **Diagnostics** - pipeline latency breakdown, logs, mic/audio device pick, MCP connection log.
- **Appearance** - theme (dark default), accent, reduced-motion respect.

---

## 5. Safety model

Voice removes the "read before you click" safety net. Therefore:

- **Destructive commands require spoken confirmation** ("Close all terminals" → "That will close 6 terminals. Say 'confirm' to proceed."). Enforced via the Agent SDK's permission hooks.
- **Control endpoint** is localhost-only, token-authed, behind a user-visible enable toggle (mirrors saple-bridge's `agent_browser` opt-in pattern).
- **Path containment & canonical-file whitelist** reused from saple-bridge patterns for any file writes.
- **Local-only mode** guarantees no audio or text leaves the machine.

---

## 6. Phased plan

Each phase is independently shippable and de-risks the next. Order is dependency-driven: prove the control loop in text before adding voice.

### Phase 0 - Foundations & scaffolding ✅
**Goal:** empty app that builds, runs, and has a home.
- Tauri app skeleton (Rust backend + web UI), tray presence, single-instance lock.
- Settings store (JSON on disk) + OS keychain wiring for secrets.
- Project structure, lint, typecheck, test harness, CI.
- This `PLAN.md`, the overview UI, and a README.
**Exit:** `june` launches to an empty window + tray icon; settings persist.

**Done:** Tauri v2 + React 19 + TypeScript + Vite, matching `saple-bridge`/`artemis-desktop`
conventions.
- `src-tauri/src/lib.rs` - single-instance lock, window-state restore, tray icon (`tray-icon`
  Cargo feature + `trayIcon` config).
- `src-tauri/src/settings.rs` - JSON settings store at `<app_data_dir>/settings.json`
  (temp-file + rename writes); round-trip covered by Rust unit tests.
- `src-tauri/src/keychain.rs` - OS keychain wiring (`june_provider_<provider>_api_key`,
  account `june_user`), no secret ever crosses the IPC boundary; ported from saple-bridge's
  proven pattern.
- `npm run typecheck` / `lint` / `test` / `build` and `cargo check` / `test` / `clippy` all
  green; CI workflow at `.github/workflows/ci.yml`.
- Verified live: `npm run tauri dev` opens a window titled "June", tray icon present, and
  `settings.json`'s `launchCount` incremented 1 → 2 across two real relaunches.
- Not yet done: no MCP servers, no agent loop, no voice - those are Phases 1+.

### Phase 1 - saple-bridge control endpoint (the prerequisite)
**Goal:** saple-bridge can be driven from outside.
- Add a localhost-only, token-authed HTTP/WS control endpoint to saple-bridge's Tauri backend.
- Backend forwards each command as a Tauri event to the renderer; a thin dispatcher calls existing store actions (`swarmStore.launchAgent`, `terminalStore.addPane`, `browser.*`, etc.) and returns the result.
- User-visible enable toggle in saple-bridge settings.
- Commands to support: spawn agents (provider/model/count/prompt), assign task, write-to/close terminal, open/close/navigate browser, read swarm status.
**Exit:** a curl/script can make saple-bridge spawn a Claude agent in the open workspace.

### Phase 2 - `saple-bridge-control` MCP server
**Goal:** the control endpoint is an MCP tool surface.
- MCP server wrapping the Phase 1 endpoint: `spawn_agents`, `send_to_terminal`, `close_terminal`, `open_browser`, `assign_task`, `get_swarm_status`.
- Publish config so any MCP client can attach it.
**Exit:** an MCP client (e.g. Claude Code) can spawn agents in saple-bridge by tool call.

### Phase 3 - Agent core (text-only) ★ key de-risking milestone
**Goal:** the whole control loop works, typed, no voice.
- Provider-pluggable agent core (`Brain` interface) with `saple-bridge-control` + `saple-memory` (+ artemis wrapped) attached. Claude (`claude-opus-4-8`) is the default brain; ship at least one non-Claude provider (e.g. OpenAI or Ollama) in this phase to prove the abstraction holds.
- Voice-tuned system prompt (short spoken-style replies, numbers spelled out, no markdown/emoji), but exercised via text first.
- Permission hooks with destructive-action confirmation.
- Streaming responses surfaced in the app UI.
**Exit:** typing "open 5 claude agents and 4 codex agents in this workspace" makes it happen and June reports back. If this works typed, voice is mechanical.

### Phase 4 - Speech to text
**Goal:** June hears you.
- `SttProvider` interface + faster-whisper (local default) and one cloud provider.
- Push-to-talk global hotkey; Silero VAD for end-of-utterance.
- Live transcription surfaced in UI.
**Exit:** hold hotkey, speak a command, see accurate transcription feed the agent.

### Phase 5 - Text to speech
**Goal:** June talks back.
- `TtsProvider` interface + Kokoro (local default) and one cloud provider.
- Sentence-by-sentence streaming so June starts speaking before the full answer is generated.
- Barge-in: user speech interrupts TTS and sends an interrupt to the session.
**Exit:** full spoken round-trip - say a command, hear the answer, interrupt mid-sentence.

### Phase 6 - Widget form ★ (details gathered here)
**Goal:** the high-quality floating surface.
- **This phase begins by asking the user for the widget spec** (the user has said they'll provide details): size, docking, transparency, expand/collapse, at-rest vs. active states, animation language, exactly what it shows (transcription, June's current action, quick results, quick actions).
- Build the widget as a second window sharing the agent core and settings.
- At-rest ambient state → active listening → thinking → speaking → result states.
**Exit:** a genuinely good widget, per the user's spec, driving the same session as the app.

### Phase 7 - Model-choice & settings depth
**Goal:** the full configurability promised in §3–§4.
- All provider pickers wired (STT/brain/TTS, local/API per stage), with per-stage test buttons.
- Full brain roster: Claude, OpenAI GPT, Google Gemini, Ollama / LM Studio, and custom OpenAI-compatible endpoints, all selectable from the UI.
- Full settings surface from §4, keychain-backed keys, local-only mode.
- Diagnostics: latency breakdown per stage, logs, device pick, MCP health.
**Exit:** user can fully choose their stack from the UI and verify each stage.

### Phase 8 - Wake word & hands-free polish
**Goal:** talk to June without touching the keyboard.
- openWakeWord with custom "Hey June" phrase; toggle + sensitivity in settings.
- Refine barge-in and turn-taking (consider Pipecat's SmartTurn if turn-taking needs work).
**Exit:** hands-free activation works reliably with low false triggers.

### Phase 9 - Capability expansion & hardening
**Goal:** prove "general-purpose" and productionize.
- Add 1–2 non-saple MCP capabilities (e.g. web research, files) to prove extensibility.
- Wrap artemis for headless missions if not already.
- Packaging, auto-update, error states, empty states, accessibility pass, performance.
**Exit:** June does something outside saple by voice; app is installable and robust.

---

## 7. Open questions (to resolve when their phase arrives)

- **Widget spec** - full details (Phase 6, user to provide).
- **Brain rollout order** - which non-Claude providers ship in Phase 3 vs Phase 7 (suggest OpenAI + Ollama first, Gemini next)? (Phase 3/7)
- **Wake word engine** - openWakeWord (free) vs Porcupine (paid, polished)? (Phase 8)
- **Multi-device** - should June ever be reachable from the phone (would justify Pipecat/LiveKit)? (post-Phase 9)

---

## 8. Default stack (recommended starting choices)

- **STT:** faster-whisper (local) - swap to Parakeet if NVIDIA GPU present.
- **Brain:** Claude `claude-opus-4-8`, effort `high` - swappable to GPT, Gemini, or a local Ollama model from settings.
- **TTS:** Kokoro-82M (local), streamed by sentence.
- **Activation:** push-to-talk first; openWakeWord "Hey June" later.
- **VAD:** Silero.
- **Packaging:** Tauri, tray-resident, standalone.

All defaults are user-overridable - that configurability is the point.
