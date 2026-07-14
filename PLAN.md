# June - Voice-Driven General-Purpose Agent

> A local-first voice agent that controls the SAPLE ecosystem (and more) by voice.
> Tell June what to do; it does it, answers back, and stays out of your way.

**Status:** Phase 0 complete
**Owner:** prabhash1889
**Repo:** `SAPLE-ALL/june` (standalone; sibling of `saple-bridge`, `saple-mcp`, `artemis`, `sentry`)
**Last updated:** 2026-07-14 (merged the control contract, invariants, and safety model from the Codex draft `JUNE-PLAN.md`; that file is superseded by this one)

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
| Bridge authority | Renderer dispatcher now, behind a Rust-ready contract | Reuses the existing store actions (days, not weeks); the contract hides where authority lives, so it can move into Rust later without touching June (see below) |
| Model choice | User-selectable per stage (STT / brain / TTS), local **or** API, per provider | Core product requirement |
| Packaging | Standalone Tauri app (Rust + web UI) with tray presence | Must outlive and launch saple-bridge; grows beyond saple |
| Activation | Push-to-talk first, wake word later | PTT is zero-false-trigger and trivial; wake word is polish |

### The control contract (frozen early, implementation-independent)

June talks to saple-bridge through exactly three operations:

```
capabilities()                         -> supported actions and limits
command(request_id, workspace_id,
        action, arguments, approval?)  -> accepted | result | error
observe(workspace_id, after_sequence)  -> ordered events
```

Contract rules (these are what make retries, restarts, and approvals safe;
they cost little now and are expensive to retrofit later):

- Every **mutating command carries a unique `request_id`** and is idempotent: retrying the same request returns the original result and creates nothing new.
- Every **resource has a stable ID**; voice labels like "Codex three" resolve to that ID before any action is taken.
- Every **event has a monotonically increasing sequence number**; `observe(after_sequence)` resumes from the last acknowledged event, so a June restart never loses the roster.
- **Batch operations return requested / started / failed / skipped counts** - partial success is a first-class result, not an error.
- **Approvals are one-time tokens** (exact action, arguments, expiry, nonce) verified by bridge before execution - see §5.

### Where authority lives (decided)

The Codex draft proposed moving all agent/terminal/browser lifecycle authority into a new Rust control module inside saple-bridge, with the React UI as a pure projection. That is the architecturally cleaner end state, but it means rewriting lifecycle logic that already works in the Zustand stores, and it delays the first working command by months.

Decision: **Phase 1 implements the endpoint as a thin dispatcher that calls the existing renderer store actions.** The contract above is the seam - June only ever sees `capabilities/command/observe`, so if renderer-mediated control proves fragile (window hung, minimized-to-tray stalls), authority migrates into Rust behind the same contract with zero changes to June. Do not start that migration until the fragility actually bites.

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
- **Privacy** - privacy mode (Standard / Local voice / Strict offline, see §5), transcript retention.
- **Diagnostics** - pipeline latency breakdown, logs, mic/audio device pick, MCP connection log.
- **Appearance** - theme (dark default), accent, reduced-motion respect.

---

## 5. Safety model

Voice removes the "read before you click" safety net. Therefore:

### Action policy (by class, not by model)

| Class | Examples | Default |
|---|---|---|
| Observe | list agents, status, summaries | automatic |
| Reversible | open/focus terminal or browser | automatic |
| Expensive | launch several paid agents | spoken confirmation with exact count |
| Destructive | stop agent, close active terminal | spoken and visible confirmation |
| External effect | submit form, send message, Git push | explicit visible approval |
| OS-wide | kill unrelated process, control another app | unavailable (deferred, see §8) |

### Approvals the brain cannot bypass

Confirmations are not just prompt discipline. An approval is a **one-time token** carrying the exact action, arguments, expiry, and nonce; the bridge endpoint verifies the token before executing. Swapping the coordinator model (Claude → GPT → local) cannot skip a gate, because the gate lives in the execution layer, not the brain. June's UI (widget and app) presents the same pending approval with approve / reject / expire states.

Additional rules:

- June never claims success until bridge returns a result or an observable completion event.
- Ambiguous targets are asked about, never guessed - especially destructive ones.
- Concurrent write-capable agents get separate Git worktrees (bridge creates them) or the launch is rejected; shared-workspace agents run read-only.
- Secrets never enter transcripts, logs, prompts, or plain-text settings; tokens and request bodies are redacted from logs.

### Privacy modes (honest tiers, not one toggle)

- **Standard** - selected cloud and local providers may be used.
- **Local voice** - microphone audio, STT, and TTS stay local; the brain and coding agents may still use the network. Never describe this mode as fully offline.
- **Strict offline** - only local models and capabilities declared offline-safe are enabled; browser navigation and cloud coding agents are blocked.

### Local transport

- Control endpoint is localhost-only, token-authed, behind a user-visible enable toggle (mirrors saple-bridge's `agent_browser` opt-in pattern). Auth cannot be disabled for mutating actions.
- Bridge publishes a **discovery record** (PID, version, workspace ID, endpoint, short-lived token) on start and removes it on clean shutdown; June verifies process liveness and protocol version before issuing commands, and rejects stale records.
- Path containment & canonical-file whitelist reused from saple-bridge patterns for any file writes.

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
**Goal:** saple-bridge can be driven from outside, through the frozen contract.
- Freeze the contract first: `capabilities` / `command` / `observe` shapes, error codes (bridge unavailable, stale workspace, denied action, duplicate request, capacity, provider failure, partial batch failure), and one serialized example of a successful and a rejected command. Contract tests pass without starting bridge.
- Add a localhost-only, token-authed HTTP/WS control endpoint to saple-bridge's Tauri backend implementing that contract.
- Backend forwards each command as a Tauri event to the renderer; a thin dispatcher calls existing store actions (`swarmStore.launchAgent`, `terminalStore.addPane`, `browser.*`, etc.) and returns the result. (Authority stays in the renderer for now - see §2 "Where authority lives".)
- Idempotency: mutating commands carry `request_id`; the endpoint deduplicates and replays the original result on retry.
- Events: every state change is emitted with a monotonic sequence number; `observe(after_sequence)` resumes cleanly.
- Discovery record with PID/version/endpoint/short-lived token, written on start, removed on clean shutdown, with stale-PID detection.
- User-visible enable toggle in saple-bridge settings.
- Commands to support: spawn agents (provider/model/count/prompt), assign task, write-to/close terminal, open/close/navigate browser, read swarm status. Batch spawn returns requested/started/failed/skipped; write-capable concurrent agents get worktrees or are rejected.
**Exit:** a curl/script can make saple-bridge spawn a Claude agent in the open workspace; retrying the same `request_id` spawns nothing new; a second script resumes `observe` and sees the same ordered events.

### Phase 2 - `saple-bridge-control` MCP server
**Goal:** the control endpoint is an MCP tool surface.
- MCP server wrapping the Phase 1 endpoint: `spawn_agents`, `send_to_terminal`, `close_terminal`, `open_browser`, `assign_task`, `get_swarm_status`.
- Tool results surface the contract's error codes and batch counts verbatim - no swallowing partial failures.
- Publish config so any MCP client can attach it.
**Exit:** an MCP client (e.g. Claude Code) can spawn agents in saple-bridge by tool call.

### Phase 3 - Agent core (text-only) ★ key de-risking milestone
**Goal:** the whole control loop works, typed, no voice.
- Provider-pluggable agent core (`Brain` interface) with `saple-bridge-control` + `saple-memory` (+ artemis wrapped) attached. Claude (`claude-opus-4-8`) is the default brain; ship at least one non-Claude provider (e.g. OpenAI or Ollama) in this phase to prove the abstraction holds.
- Approval flow per §5: pending / approve / reject / expire, one-time tokens verified by bridge; the same approval renders in the app UI. Expensive launches confirm with exact counts; destructive actions confirm visibly.
- Reference resolution: "the third Codex agent" resolves against live resource state to a stable ID; ambiguity asks, never guesses.
- Voice-tuned system prompt (short spoken-style replies, numbers spelled out, no markdown/emoji), but exercised via text first.
- Streaming responses surfaced in the app UI; June reports outcomes only from bridge results/events, never from intent.
**Exit:** typing "open 5 claude agents and 4 codex agents in this workspace" makes it happen exactly once (retry-safe), June reports started/failed/skipped accurately, and switching the brain provider cannot bypass an approval. If this works typed, voice is mechanical.

### Phase 4 - Speech to text
**Goal:** June hears you.
- `SttProvider` interface + faster-whisper (local default) and one cloud provider.
- Push-to-talk global hotkey; Silero VAD for end-of-utterance.
- Live transcription surfaced in UI; no action begins before the transcript is accepted.
- Handle permission denial, missing device, partial transcript, cancellation, and timeout.
**Exit:** hold hotkey, speak a command, see accurate transcription feed the agent.

### Phase 5 - Text to speech
**Goal:** June talks back.
- `TtsProvider` interface + Kokoro (local default) and one cloud provider.
- Sentence-by-sentence streaming so June starts speaking before the full answer is generated.
- Barge-in: user speech interrupts TTS and sends an interrupt to the session.
- June's own audio must never be picked up as a confirmation.
**Exit:** full spoken round-trip - say a command, hear the answer, interrupt mid-sentence - with no duplicate execution.

### Phase 6 - Widget form ★ (details gathered here)
**Goal:** the high-quality floating surface.
- **This phase begins by asking the user for the widget spec** (the user has said they'll provide details): size, docking, transparency, expand/collapse, at-rest vs. active states, animation language, exactly what it shows (transcription, June's current action, quick results, quick actions).
- Build the widget as a second window sharing the agent core and settings.
- At-rest ambient state → active listening → thinking → speaking → result states, plus approval, partial-success, and failure states.
**Exit:** a genuinely good widget, per the user's spec, driving the same session as the app - a command can start in the widget and be inspected or approved in the application.

### Phase 7 - Model-choice, settings depth & privacy modes
**Goal:** the full configurability promised in §3-§4, with honest privacy.
- All provider pickers wired (STT/brain/TTS, local/API per stage), with per-stage test buttons.
- Full brain roster: Claude, OpenAI GPT, Google Gemini, Ollama / LM Studio, and custom OpenAI-compatible endpoints, all selectable from the UI.
- Privacy modes per §5: Standard / Local voice / Strict offline, enforced via per-capability offline-safe metadata - Strict offline rejects every declared network capability, and Local voice is never described as fully offline.
- Show estimated provider cost and network use before high-fan-out actions.
- Full settings surface from §4, keychain-backed keys.
- Diagnostics: latency breakdown per stage, logs, device pick, MCP health.
**Exit:** user can fully choose their stack from the UI and verify each stage; switching providers preserves commands and pending approvals.

### Phase 8 - Wake word & hands-free polish
**Goal:** talk to June without touching the keyboard.
- openWakeWord with custom "Hey June" phrase; toggle + sensitivity in settings.
- Refine barge-in and turn-taking (consider Pipecat's SmartTurn if turn-taking needs work).
**Exit:** hands-free activation works reliably with low false triggers.

### Phase 9 - Capability expansion & hardening
**Goal:** prove "general-purpose" and productionize.
- Add 1-2 non-saple MCP capabilities (e.g. web research, files) to prove extensibility.
- Wrap artemis for headless missions if not already.
- Recovery drills: killed June, killed bridge, killed Claude/Codex process, duplicate requests, partial batches, expired approvals, provider downtime, slow voice stages, app upgrade. Restarting June must restore the same observable state (via `observe` resume) without relaunching anything.
- Structured redacted logs, diagnostics export, accessibility pass, packaging, auto-update, performance; measure command acceptance, execution, and spoken-response latency.
**Exit:** June does something outside saple by voice; an installable build recovers safely from every drill above.

---

## 7. First-release acceptance scenario

This scenario - not the number of settings, providers, or MCP servers - defines the first useful June release:

1. Bridge is open on `SAPLE-ALL`; June discovers and authenticates to it.
2. The user says: "Open five Claude agents and four Codex agents in this workspace."
3. June repeats the provider counts, workspace, worktree policy, and cost class; the user approves once.
4. Bridge executes one idempotent batch and emits ordered events; June reports started, failed, and blocked agents by stable spoken label.
5. The user assigns a task to an agent, asks for status, opens a browser tab, and closes a bridge terminal.
6. Restarting June restores the same observable state without relaunching anything.

---

## 8. Deferred until a real requirement appears

- Moving bridge authority from the renderer dispatcher into a Rust control module (contract already permits it - see §2).
- Standalone/headless orchestration daemon.
- Remote or phone control.
- Arbitrary Windows application/process control (OS-wide actions stay unavailable).
- Browser DOM automation and credentialed form submission.
- Custom plugin system beyond MCP.
- Multi-user permissions or cloud synchronization.

---

## 9. Open questions (to resolve when their phase arrives)

- **Widget spec** - full details (Phase 6, user to provide).
- **Brain rollout order** - which non-Claude providers ship in Phase 3 vs Phase 7 (suggest OpenAI + Ollama first, Gemini next)? (Phase 3/7)
- **Wake word engine** - openWakeWord (free) vs Porcupine (paid, polished)? (Phase 8)
- **Multi-device** - should June ever be reachable from the phone (would justify Pipecat/LiveKit)? (post-Phase 9)

---

## 10. Default stack (recommended starting choices)

- **STT:** faster-whisper (local) - swap to Parakeet if NVIDIA GPU present.
- **Brain:** Claude `claude-opus-4-8`, effort `high` - swappable to GPT, Gemini, or a local Ollama model from settings.
- **TTS:** Kokoro-82M (local), streamed by sentence.
- **Activation:** push-to-talk first; openWakeWord "Hey June" later.
- **VAD:** Silero.
- **Packaging:** Tauri, tray-resident, standalone.

All defaults are user-overridable - that configurability is the point.
