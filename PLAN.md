# June - Voice-Driven General-Purpose Agent

> A local-first voice agent that controls the SAPLE ecosystem (and more) by voice.
> Tell June what to do; it does it, answers back, and stays out of your way.

> **This document is design-only.** For what has actually landed, read `git log`
> and the highest-numbered `improvement-N.md` at the repo root - not a status line
> here. A running status header used to live here; it drifted far enough that both
> CLAUDE.md and README.md told readers to ignore it, so it was cut (4.2) rather than
> re-stamped into staleness again. The phase sections below are the *design intent*,
> which does not go stale the way a progress tally does.

**Owner:** prabhash1889
**Repo:** `SAPLE-ALL/june` (standalone; sibling of `saple-bridge`, `saple-mcp`, `artemis`, `sentry`)

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

**Committed vs. opportunistic:** the tables below are the design *target*, not a build list. Only the default stack in §10 (one STT, one brain, one TTS) is committed for the first useful release (§7). Every other provider is opportunistic - added when a real need appears, one interface impl at a time - never a prerequisite for shipping the acceptance scenario. Do not build the full matrix before one stack works end-to-end.

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

**Known schedule risks (flagged, not yet mitigated):**
- **saple-bridge coupling** - Phase 1's real completion and everything after it depends on a live saple-bridge whose renderer stores June's dispatcher drives. Bridge is a separate product; if its internals shift, June stalls. Mitigation is the contract seam (§2) plus the Phase 1 live-smoke gate above - keep them honest.
- **Widget spec unknown** - Phase 6 is a whole second UI surface with no spec yet ("user to provide"). It sits in the middle of the plan as a sizeable unestimated unknown; treat its scope as open until §9's widget question is answered.
- **Voice-pipeline test flakiness** - Phases 4-5 exit criteria are manual ("hold hotkey, speak"). Real audio E2E tests are flaky by nature. Before those phases, decide the test strategy (recorded-audio fixtures / mocked device / golden transcripts) so the voice stages don't become an untested, flaky corner of an otherwise rigorously-tested codebase.

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

### Phase 1 - saple-bridge control endpoint (the prerequisite) ✅
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

**Done:** Contract frozen in june; endpoint + renderer dispatcher + settings toggle in saple-bridge.
- **Contract (june):** `src/contract/types.ts` (the three operations, frozen `ERROR_CODES` and
  `ACTIONS`, `ApprovalToken`, `BatchCounts`), `src/contract/validate.ts` (trust-boundary validators
  enforcing the invariants), and `src/contract/examples/*.json` as the language-neutral golden
  source of truth. `src/contract/contract.test.ts` passes without starting bridge (8 tests).
- **Endpoint (saple-bridge `src-tauri/src/june_control.rs`):** localhost-only, token-authed
  `tiny_http` server on an ephemeral loopback port, off by default behind a `june-control.enabled`
  flag file. Owns the transport-independent core - monotonic sequenced event log with
  `observe(after_sequence)` resume, and `request_id` idempotency (replay on retry,
  `duplicate_request` on conflicting reuse) - all unit-tested (5 Rust tests). Publishes a discovery
  record (`june-control.json`: pid/endpoint/token/version) on start, removed on clean shutdown;
  liveness checked via pid.
- **Dispatcher (saple-bridge `src/lib/juneDispatcher.ts`):** authority stays in the renderer -
  `command` is forwarded as the `june://command` event, run against the existing stores
  (`terminalStore.addPane`/`removePane`, `write_pty`, `browserStore`, `swarmStore`), state changes
  reported via `june_emit_event`, results returned via `june_command_result`. Batch spawn returns
  summing requested/started/failed/skipped counts.
- **Toggle:** "June Voice Control" in Workspace settings (mirrors the agent-browser opt-in). All
  164 bridge frontend tests + typecheck + lint + clippy green.
- **Gate before Phase 2 (met 2026-07-19):** the exit criterion is a *live* end-to-end check (bridge
  running, workspace open, real agent CLIs) - `june/scripts/phase1-smoke.ps1` ran green against a
  live bridge (pid discovered via `june-control.json`, protocol v1): `spawn_agents` started one
  Claude agent, retrying the same `request_id` replayed the identical result and spawned nothing new,
  and `observe` returned the ordered event then resumed clean with no repeats. Phase 2 is unblocked.
  Deferred to their own phases per the plan: approval one-time-token
  *verification* in the endpoint (§5, exercised in Phase 3), stale-workspace mapping between June's
  logical `workspace_id` and bridge's internal workspace key (Phase 3), and WS streaming for
  `observe` (polling suffices now).

### Phase 2 - `saple-bridge-control` MCP server ✅
**Goal:** the control endpoint is an MCP tool surface.
- MCP server wrapping the Phase 1 endpoint: `spawn_agents`, `send_to_terminal`, `close_terminal`, `open_browser`, `assign_task`, `get_swarm_status`.
- Tool results surface the contract's error codes and batch counts verbatim - no swallowing partial failures.
- Publish config so any MCP client can attach it.
**Exit:** an MCP client (e.g. Claude Code) can spawn agents in saple-bridge by tool call.

**Done:** a stdio MCP server at `mcp/saple-bridge-control/` (run with `tsx`, no build step), wrapping the Phase 1 endpoint as six tools.
- **Transport (`mcp/saple-bridge-control/bridge.ts`):** finds bridge via its discovery record (`%APPDATA%/ai.saple.bridge/june-control.json`), vetting protocol version and pid liveness before any call (any failure → one contract `bridge_unavailable`); speaks the localhost `/capabilities` `/command` endpoint. Reuses June's frozen contract (`CONTRACT_VERSION`, `Action`) as the single source of truth - no re-declared action list. Discovery vetting is unit-tested (4 tests, no bridge needed).
- **Server (`mcp/saple-bridge-control/server.ts`):** six tools mapping one-to-one to contract actions (`send_to_terminal`→`write_terminal`; the rest by name). Bridge's `CommandResponse` is returned **verbatim** - error codes and batch counts never swallowed. Mutating tools take an optional `request_id` for idempotent retries (bridge replays); each omitted id is a fresh `randomUUID()`. Optional `workspace_id` (default `june`) scopes observe routing.
- **Publish:** `mcp.config.example.json` + `README.md` show how to attach it (`claude mcp add ...`). `typecheck`/`lint`/`test` extended to cover `mcp/**`; all green.
- **Gate (met 2026-07-19):** driven as a real MCP client over stdio (SDK `Client` + `StdioClientTransport`) against a live bridge - `listTools` returned all six, `get_swarm_status` read the roster, and `spawn_agents` started one real Claude agent (`counts.started: 1`, agent id returned). Deferred to Phase 3: approval-token args on gated tools, and June's logical→bridge workspace mapping.

### Phase 3 - Agent core (text-only) ★ key de-risking milestone ✅
**Goal:** the whole control loop works, typed, no voice.
- Provider-pluggable agent core (`Brain` interface) with `saple-bridge-control` + `saple-memory` (+ artemis wrapped) attached. Claude (`claude-opus-4-8`) is the default and **only committed** brain for this phase - ship the `Brain` interface with one working implementation. A second non-Claude provider is deferred to Phase 7 (where the full roster lives); the voice-pipeline risk here is high and the provider-abstraction risk is low, so proving the *loop* comes first, not proving the *abstraction*. Design the interface so a second provider is a later config entry, but do not build one now.
- Approval flow per §5: pending / approve / reject / expire, one-time tokens verified by bridge; the same approval renders in the app UI. Expensive launches confirm with exact counts; destructive actions confirm visibly.
- Reference resolution: "the third Codex agent" resolves against live resource state to a stable ID; ambiguity asks, never guesses.
- Voice-tuned system prompt (short spoken-style replies, numbers spelled out, no markdown/emoji), but exercised via text first.
- Streaming responses surfaced in the app UI; June reports outcomes only from bridge results/events, never from intent.
**Exit:** typing "open 5 claude agents and 4 codex agents in this workspace" makes it happen exactly once (retry-safe), June reports started/failed/skipped accurately, and an approval gate cannot be bypassed by the brain (verified in the execution layer, so it holds regardless of provider). If this works typed, voice is mechanical. (The provider-swap-can't-skip-a-gate check moves to Phase 7 when a second brain exists.)

**Done:** a provider-neutral agent core at `agent/` (Node-scoped, run with `tsx`), driving the Phase 2 MCP tools.
- **Brain (`agent/brain.ts` + `agent/claude-brain.ts`):** one `Brain` interface; Claude is the only committed impl, over `@anthropic-ai/claude-agent-sdk` `query()` (uses the local `claude` auth or `ANTHROPIC_API_KEY`). Built-in tools are disabled (`tools: []`) and the developer's own Claude settings ignored (`settingSources: []`) - June may only touch the workspace through attached MCP servers. `saple-bridge-control` is attached with `alwaysLoad: true` so its tools are always in the prompt (without a tool-search tool the model otherwise hallucinated tool names). A second provider is a later `Brain` impl, not a new loop.
- **Approval gate (`agent/policy.ts`, wired via the SDK `canUseTool` hook in `claude-brain.ts`):** classified by §5 action class, not by model, and enforced at the tool dispatch point - the brain cannot run a gated tool without a decision from June's core, so it "holds regardless of provider". `spawn_agents` (expensive, confirmed with exact count) and `close_terminal` (destructive) are gated; observe/reversible run automatically. Fails closed. Classification unit-tested (4 tests).
- **Voice-tuned prompt (`agent/prompt.ts`):** spoken-style, numbers spelled out, no markdown; reports outcomes only from tool results, resolves labels via `get_swarm_status` and asks when ambiguous.
- **Text harness (`agent/cli.ts`):** one-shot or REPL; `npm run agent`. `JUNE_APPROVE=allow|deny` gives a headless approval policy.
- **Gate met live (2026-07-19):** against a running bridge - `get_swarm_status` read the roster and June reported it in voice style; a denied "open two claude agents" blocked the spawn (result: not approved, nothing started); an approved single spawn started one agent; and the full "open 5 claude + 4 codex" decomposed into two spawns, started all 9 (counts 5/5/0/0 and 4/4/0/0), and June reported them accurately.
- **Deferred:** the §5 *one-time token verified by bridge* (the execution-layer gate already meets the exit criterion; bridge-side token mint/verify is defense-in-depth, best paired with the Rust authority migration), and the app-UI stream/approval surface (reuses this same core).

### Phase 4 - Speech to text
**Goal:** June hears you.
- `SttProvider` interface + faster-whisper (local default) and one cloud provider.
- Push-to-talk global hotkey; Silero VAD for end-of-utterance.
- Live transcription surfaced in UI; no action begins before the transcript is accepted.
- Handle permission denial, missing device, partial transcript, cancellation, and timeout.
**Exit:** hold hotkey, speak a command, see accurate transcription feed the agent.

**Done (implementation + automated gates; live speak-check pending a manual run):** the app's face is now the voice surface (`src/App.tsx` → `src/voice/VoicePanel.tsx`), driving the same Phase 3 core.
- **STT provider (Rust `src-tauri/src/stt.rs`):** an `SttProvider` trait (mirrors the `Brain` seam) with one committed impl, `OpenAiStt` (Whisper `whisper-1`). The transcription call lives in Rust **on purpose** - the OpenAI key is read from the keychain (`get_api_key_inner`, the call site keychain.rs was waiting for) and never crosses IPC; the webview sends only raw audio bytes and gets back text. Empty/missing key, HTTP failure, and timeout each map to a clear message; an empty transcript is a first-class "didn't catch that", not a crash. faster-whisper (local default per §10) is a later impl of the same trait, not a new path. mime→extension mapping unit-tested (Rust).
- **Push-to-talk (Rust `lib.rs`):** `tauri-plugin-global-shortcut` registers Ctrl+Shift+Space; the plugin's Pressed/Released edges (true hold-to-talk, which a terminal can't emit) bridge to the webview as `ptt://down` / `ptt://up` events.
- **Capture + VAD (`src/lib/voice-capture.ts`):** getUserMedia + MediaRecorder for platform-native capture (device pick, permission, resampling); a `SilenceDetector` (energy-threshold VAD with a silence hangover) auto-ends the utterance, with a 15s hard cap. `ponytail:` energy VAD not Silero - the hotkey release is the real end signal; Silero swaps in here for Phase 8 open-mic. VAD logic + getUserMedia error classification unit-tested (vitest).
- **Accept gate (`VoicePanel.tsx`):** live level-reactive orb → transcribe → **transcript review card** (editable) → Send/Re-record/Cancel. Nothing reaches the agent until the transcript is explicitly accepted (§5: voice removes the "read before you click" net). Handles permission denial, missing device, empty/partial transcript, timeout, and cancellation as distinct states; prompts for the OpenAI key up front if absent.
- **Feed the agent (`agent/run-once.ts` + Rust `agent_runner.rs`):** an accepted transcript feeds the **same** Phase 3 core - Rust spawns `agent/run-once.ts` (a JSONL one-shot over `createJuneAgent`, "only the surface differs") and returns June's reply. Gate is **fail-closed**: gated (expensive/destructive) voice actions are denied until the approval UI exists, so voice can't silently spawn paid agents; observe/reversible actions run automatically. `ponytail:` dev-time `npx tsx` invocation, matching the Phase 1-3 harnesses; bundling the Node core as a sidecar binary is Phase 9.
- **Gates green:** `typecheck` / `lint` / `test` (23 JS) and `cargo check` / `clippy` / `test` (5 Rust) all pass; production `vite build` bundles the surface.
- **Remaining (the live exit check, manual - needs a real mic + OpenAI key, same as prior phases' live gates):** hold Ctrl+Shift+Space, speak, confirm accurate transcription reaches the agent. Deferred to later phases per plan: streaming interim transcription (needs a streaming STT like Deepgram; Whisper is batch), the in-UI agent-stream + voice **approval** surface (Phase 6 app-stream tail), a configurable hotkey (Phase 7), and local faster-whisper (Phase 7).

### Phase 5 - Text to speech
**Goal:** June talks back.
- `TtsProvider` interface + Kokoro (local default) and one cloud provider.
- Sentence-by-sentence streaming so June starts speaking before the full answer is generated.
- Barge-in: user speech interrupts TTS and sends an interrupt to the session.
- June's own audio must never be picked up as a confirmation.
**Exit:** full spoken round-trip - say a command, hear the answer, interrupt mid-sentence - with no duplicate execution.

**Done (implementation + automated gates; live spoken round-trip pending a manual run):** the same voice surface now speaks June's reply back, streamed and interruptible.
- **TTS provider (Rust `src-tauri/src/tts.rs`):** a `TtsProvider` trait (mirrors the `SttProvider`/`Brain` seams) with one committed impl, `OpenAiTts` (OpenAI `tts-1`, voice `alloy`, mp3). Same rationale as STT: the OpenAI key (reused from the STT keychain entry, no new key) is read in Rust and never crosses IPC - the webview sends text down and plays back the bytes. Empty/missing key, HTTP failure, and timeout each map to a clear message; empty text is a no-op. Kokoro (local default per §10) is a later impl of the same trait, not a new path - exactly how Phase 4 committed OpenAI Whisper and left faster-whisper for Phase 7.
- **Sentence streaming (`src/lib/tts.ts`):** `SentenceBuffer` flushes complete sentences from the streamed reply as soon as their terminator lands (splitter unit-tested, vitest); `SpeechQueue` synthesizes each sentence as it is enqueued (network round-trips overlap playback) and plays them in order, so June starts speaking before the answer finishes generating. `agent/run-once.ts` already emits per-token `{"t":"text"}` lines; `agent_runner.rs` now reads stdout line-by-line and re-emits each delta as an `agent://text` Tauri event (tagged with a `turn`) instead of only returning the final line. The final reply is still returned for display and as a fallback if a brain streams no deltas.
- **Barge-in (`VoicePanel.tsx` + `startBargeMonitor` in `voice-capture.ts`):** while June speaks, an echo-cancelled monitor mic watches for sustained user speech; detected speech (or a push-to-talk press) stops playback and starts a fresh capture. **"June's own audio is never picked up"** is handled by the browser's native acoustic echo cancellation (`echoCancellation`), which removes June's speaker output from the mic before the VAD sees it, plus a sustain window that rejects residual AEC leak. Barge-in only stops audio and bumps the `turn`; it never kills or re-runs the agent, so the interrupted turn (idempotent tools) can't double-execute (**exit: "no duplicate execution"**).
- **Gates green:** `typecheck` / `lint` / `test` (27 JS, +4 splitter) and `cargo check` / `clippy -D warnings` / `test` (5 Rust) all pass; production `vite build` bundles the surface.
- **Remaining (the live exit check, manual - needs a real mic + OpenAI key, same as prior phases):** speak a command, hear the streamed answer, interrupt mid-sentence, confirm no duplicate execution. Deferred per plan: local Kokoro TTS (Phase 7), and robust barge-in - Silero VAD + tuned turn-taking/AEC - is the Phase 8 "refine barge-in" work (`ponytail:` energy VAD + browser AEC is the honest first cut). The in-UI **approval** surface for gated voice actions stays fail-closed until Phase 6.

### Phase 6 - Widget form ★ (details gathered here)
**Goal:** the high-quality floating surface.
- **This phase begins by asking the user for the widget spec** (the user has said they'll provide details): size, docking, transparency, expand/collapse, at-rest vs. active states, animation language, exactly what it shows (transcription, June's current action, quick results, quick actions).
- Build the widget as a second window sharing the agent core and settings.
- At-rest ambient state → active listening → thinking → speaking → result states, plus approval, partial-success, and failure states.
**Exit:** a genuinely good widget, per the user's spec, driving the same session as the app - a command can start in the widget and be inspected or approved in the application.

**Done (implementation + automated gates; live check pending a manual run):** June is now one app with two faces over a single agent session, and the approval gate is finally interactive.
- **Widget spec (gathered from the user):** at-rest **orb that expands into a card**; **free-drag, position remembered**; **frameless, always-on-top, opaque** (the user revised the spec after seeing the transparent version: a solid tile, no transparency); **widget is the default face, the full app opens on demand**. Built exactly to that.
- **Widget window (`src/widget/WidgetWindow.tsx`, `tauri.conf.json` `main`):** frameless + always-on-top + skip-taskbar, `resizable:false`, opaque (`transparent:false`) with the OS window shadow (`shadow:true`) carrying the depth. At rest it is an 88x88 tile hugging the 64px orb; whenever June is doing anything (or an approval is pending) `VoicePanel` reports `active` and the shell grows the OS window to the 340x440 card and back (`set_widget_expanded`), keeping the **bottom-right corner anchored** so a corner-parked widget expands into the screen, not off it. Free-drag via a `data-tauri-drag-region` frame around the content; **position is remembered for free** by the existing `tauri-plugin-window-state`. The shell owns window geometry only - the Phase 4/5 voice pipeline in `VoicePanel` is reused verbatim.
- **Full app window (`src/app/AppWindow.tsx`, Rust `show_app`):** opened on demand (`⤢` on the widget, or the tray) via a `WebviewWindowBuilder` that focuses the window if it already exists. Same bundle, different face - `src/main.tsx` routes by window label (`app` -> `AppWindow`, else the widget). It renders the **live conversation** (you / June / tool activity with batch counts) and the **approval surface**, but owns no mic and never speaks (the widget owns audio, so no double capture or double TTS). Settings / model pickers / MCP management are labelled as Phase 7, not faked.
- **Same session across windows:** the backend (`agent_runner.rs`) now broadcasts every step of a turn as an `agent://*` event (`user`/`text`/`tool`/`result`/`approval`/`approval-resolved`/`final`, each tagged with `turn`) to **all** windows, so a command spoken into the widget shows up in the app as it happens. It also **records** `user`/`tool`/`result`/`final` in a capped in-memory session log (`session_events`; text deltas are live-only - the `final` supersedes them), each stamped with a monotonic `seq`; a full-app window opened mid-session replays the log before applying live events (deduplicated by `seq`), so the conversation is never empty just because the window opened late. No shared renderer state - the Rust session log is the single source of truth (exactly the seam the contract set up).
- **Interactive approval (replaces Phases 4/5 fail-closed stub):** `agent/run-once.ts`'s gate now emits an `{"t":"approval",...}` line and **blocks on stdin** until a decision arrives; `agent_runner.rs` holds the running process's stdin so `resolve_approval(id, decision)` writes the answer back, and stores the pending approval so a full-app window opened mid-approval seeds itself via `pending_approval`. The gate still lives in June's execution layer (PLAN.md §5) - the brain proposes, June's core decides - so it holds regardless of brain. **Fails closed:** no decision within 120s denies (implements §5 "approvals expire"), and expiry now also clears the prompt in every window (run-once emits `approval-expired` -> `agent://approval-resolved`), so a late click errors instead of looking delivered; barge-in or cancel withdraws a pending approval. Turns can overlap after a barge-in (the old process is left to finish), so the channel is turn-safe: a barged-in-on turn's stdin is dropped when the new turn installs its own, its gate then self-denies immediately (closed channel) and its later approval prompts are never surfaced; `resolve_approval` validates the decision against the pending approval's id and routes it to that approval's own turn, never to whichever turn holds the channel now. Either window can approve/reject the **same** shared prompt (`agent://approval-resolved` clears both). This satisfies the exit: start "open two claude agents" in the widget, approve or reject it from the full app.
- **Gates green:** `typecheck` / `lint` / `test` (27 JS) and `cargo check` / `clippy -D warnings` / `test` (5 Rust) all pass; production `vite build` bundles both faces.
- **Remaining (the live exit check, manual - needs a real mic + OpenAI key, same as prior phases):** open the widget, speak a gated command, watch it appear in the full app, and approve it there. Deferred per plan: settings depth / model pickers / MCP management / diagnostics (Phase 7), the §5 *bridge-side one-time token* (still defense-in-depth, best paired with the Rust authority migration), and richer at-rest ambient animation.

### Phase 7 - Model-choice, settings depth & privacy modes
**Goal:** the full configurability promised in §3-§4, with honest privacy.
- All provider pickers wired (STT/brain/TTS, local/API per stage), with per-stage test buttons.
- Full brain roster: Claude, OpenAI GPT, Google Gemini, Ollama / LM Studio, and custom OpenAI-compatible endpoints, all selectable from the UI.
- Privacy modes per §5: Standard / Local voice / Strict offline, enforced via per-capability offline-safe metadata - Strict offline rejects every declared network capability, and Local voice is never described as fully offline.
- Show estimated provider cost and network use before high-fan-out actions.
- Full settings surface from §4, keychain-backed keys.
- Diagnostics: latency breakdown per stage, logs, device pick, MCP health.
**Exit:** user can fully choose their stack from the UI and verify each stage; switching providers preserves commands and pending approvals.

**Done (implementation + automated gates; live provider round-trips pending a manual run):** the app window's second face is now a real settings surface, and the brain roster is genuinely swappable.
- **Provider registry (`src/lib/providers.ts`):** the single source of truth for every stage - each provider carries `kind` (local/API), `keyService`, `baseUrl`, `offlineSafe` metadata, and an `available` flag. The settings UI renders from it, privacy reads its metadata, and the agent resolves the brain's base URL from it, so adding a provider is a config entry, not new wiring (§3). Honesty rule kept: local voice (faster-whisper, Kokoro) is listed so the intended stack is visible but marked `available: false` (not selectable) - never a stage that would error.
- **Typed settings (`src/lib/settings.ts`):** a typed view over the Phase 0 JSON bag - reads with per-field defaults (an old/partial file still loads) and writes by MERGING over the raw bag, so keys the schema doesn't own are never clobbered. Keys stay in the OS keychain (`hasKey`/`setKey`/`deleteKey`), never in settings.json.
- **Brain roster made real (`agent/openai-brain.ts`):** one committed second impl of the `Brain` seam - `OpenAiCompatBrain` - covers OpenAI GPT, Google Gemini (its OpenAI-compat endpoint), Ollama, LM Studio, and any custom OpenAI-compatible server, differing only by base URL/model/key. Unlike Claude (which gets the loop from the Agent SDK), it runs its own tool-calling loop: connects to June's MCP capability servers as an MCP client, exposes their tools to `/chat/completions`, and routes every proposed tool call through the **same execution-layer gate** the orchestrator passes in - so the approval gate holds "regardless of provider" (§5). MCP->OpenAI tool-schema translation is unit-tested; the loop is a live manual gate like every prior provider. `ponytail:` non-streaming completions (the sentence buffer still splits the reply for speech); SSE streaming is a later refinement.
- **Selection actually takes effect:** `agent_runner.rs` reads the chosen brain from settings.json and passes provider/model/effort/base-URL/privacy-mode to the run-once child via env, reading the provider's API key from the OS keychain HERE so it reaches the Node agent without crossing the webview IPC (same rule STT/TTS follow). `agent/core.ts` picks ClaudeBrain vs OpenAiCompatBrain by provider; `run-once.ts` resolves the config and creates the agent. Absent settings -> Claude, exactly as before Phase 7. Because settings are read fresh per turn, switching a provider never disturbs an in-flight command or a pending approval (which live in the Rust session).
- **Settings UI (`src/app/SettingsPanel.tsx`, mounted as the app window's second view):** Models (provider + model + per-stage **Test** button; brain also has effort + a custom-endpoint field; TTS has a voice picker), API keys (per provider, keychain-backed, save/clear + presence dot), Privacy (the three §5 modes with live violation warnings), Activation (the fixed hotkey, honestly labelled), and Diagnostics (bridge/MCP health probe). Test buttons are real checks: STT records ~2.5s and transcribes; the brain probes its endpoint's `/models` (Rust reads the key, no tokens spent - `diagnostics::test_brain`); TTS synthesizes and plays a sample in the chosen voice. Each shows round-trip latency (the §4 per-stage latency breakdown). Mounted only when selected, so the conversation stays the default and nothing loads until asked.
- **Privacy modes enforced from metadata (`src/lib/privacy.ts`), not just the form:** Standard / Local voice / Strict offline reduce to one pure `providerAllowed` check driven by `offlineSafe`. It gates the UI (violation warnings) AND the run path - `run-once.ts` refuses a networked brain when the mode forbids it (verified live: `openai` under `strict-offline` is blocked before the brain runs), and `VoicePanel` disables the mic when the mode blocks cloud voice (June has no local voice provider yet). Local voice is never described as fully offline. Unit-tested across all three tiers.
- **Cost/network before high fan-out (§5):** the spawn approval now states the class ("paid, uses network") alongside the exact count - a class, not a dollar quote (real per-token cost is unknowable pre-run). TTS voice/model selection also takes effect on the live pipeline (`tts.rs` validates voice/model, falling back on bad input; unit-tested).
- **Gates green:** `typecheck` / `lint` / `test` (37 JS, +10) and `cargo check` / `clippy -D warnings` / `test` (7 Rust, +1) all pass; production `vite build` bundles both faces.
- **Remaining (the live exit check, manual - needs real keys/mic, same as prior phases):** pick a non-Claude brain, set its key, test the stage green, and run a spoken command through it; verify a provider switch mid-session preserves the running command and any pending approval. Deferred per §3 (opportunistic, one impl at a time): local voice providers (faster-whisper / Kokoro), a user-configurable hotkey + device picker, SSE streaming for non-Claude brains, and applying `effort` where a provider's API exposes it (the Agent SDK and OpenAI chat models don't today - it is persisted and shown, not faked).

### Phase 8 - Wake word & hands-free polish
**Goal:** talk to June without touching the keyboard.
- openWakeWord with custom "Hey June" phrase; toggle + sensitivity in settings.
- Refine barge-in and turn-taking (consider Pipecat's SmartTurn if turn-taking needs work).
**Exit:** hands-free activation works reliably with low false triggers.

**Done (implementation + automated gates; live hands-free check pending a manual run):** June now activates on a spoken phrase, and the barge-in monitor floats above the room's noise.
- **Wake detector (`src/lib/wake.ts`):** the committed first cut is STT-gated phrase spotting - an on-device energy VAD (reusing `SilenceDetector`/`rms`) segments only short speech bursts, each burst is transcribed through the already-wired cloud STT, and `phraseMatches` fires the wake callback when the burst contains the phrase. It is honest about what it is: the mic isn't streamed to the cloud continuously (silence is never transcribed), but it IS a cloud activity, so it is disabled under any privacy mode that keeps voice on-device (there is no local voice provider yet) - surfaced in settings, not hidden. The wake trigger drives the **same** `activate()` a push-to-talk press does, so the whole Phase 4/5 pipeline (listen → review → run → speak) is reused verbatim. `ponytail:` a fully-local openWakeWord ONNX "Hey June" model swaps in behind the same `onWake` callback once a trained model exists - the callback is the seam, exactly how faster-whisper/Kokoro sit behind the STT/TTS seams. `phraseMatches` (normalize + edit-distance window, sensitivity scales the edit budget) is unit-tested across exact/mishear/unrelated/strict/loose (6 tests) - the low-false-trigger contract is the tested part.
- **Toggle + phrase + sensitivity (`settings.ts` `WakeConfig`, `src/app/SettingsPanel.tsx` Activation):** off by default (PTT stays the zero-false-trigger baseline; wake is opt-in). The Activation section gains a wake toggle, an editable phrase (default "hey june"), and a sensitivity slider (0..1: strict = fewest false triggers, loose = easiest to trigger), all persisted to settings.json and read fresh per turn. The toggle is disabled with an honest note when the privacy mode blocks cloud voice.
- **Hands-free wiring (`VoicePanel.tsx`):** while June is at rest (idle, voice allowed, no pending approval) and wake is enabled, an ambient wake listener runs; the effect tears it down the instant activation moves June out of idle (so the mic is never contended while capturing/thinking/speaking) and re-arms it when June returns to rest, giving continuous hands-free. A denied/absent mic fails soft - hands-free is just unavailable, PTT and the orb still work.
- **Barge-in refined (`voice-capture.ts` `startBargeMonitor`):** the fixed 0.05 trip threshold is replaced by an adaptive one - the monitor spends its first ~500ms learning the room's noise floor (which, thanks to AEC, includes June's own residual leak while it speaks) and requires speech to clear floor + margin. This cuts false interruptions from a loud room or AEC leak while staying sensitive in a quiet one - directly serving the "low false triggers" exit. `ponytail:` adaptive energy VAD + browser AEC is the honest cut; Silero VAD / Pipecat SmartTurn swap in here only if turn-taking measurably needs it (the plan makes SmartTurn conditional).
- **Gates green:** `typecheck` / `lint` / `test` (42 JS, +6 wake) all pass; production `vite build` bundles the surface. No Rust changes - the wake path reuses the existing `transcribe` command and the barge-in refinement is browser-side.
- **Remaining (the live exit check, manual - needs a real mic + OpenAI key, same as prior phases):** enable wake word, say "Hey June", confirm it activates reliably and background speech does not. Deferred per §3/§10 (opportunistic, one impl at a time): the fully-local openWakeWord "Hey June" model (needs a trained ONNX model - keeps continuous listening off the cloud), Porcupine as the paid alternative, and Silero/SmartTurn turn-taking if the energy VAD proves insufficient in practice.

### Phase 9 - Capability expansion & hardening
**Goal:** prove "general-purpose" and productionize.
- Add 1-2 non-saple MCP capabilities (e.g. web research, files) to prove extensibility.
- Wrap artemis for headless missions if not already.
- Recovery drills: killed June, killed bridge, killed Claude/Codex process, duplicate requests, partial batches, expired approvals, provider downtime, slow voice stages, app upgrade. Restarting June must restore the same observable state (via `observe` resume) without relaunching anything.
- Structured redacted logs, diagnostics export, accessibility pass, packaging, auto-update, performance; measure command acceptance, execution, and spoken-response latency.
**Exit:** June does something outside saple by voice; an installable build recovers safely from every drill above.

**Done (headline capability + automated gates; hardening tail deferred):** June has its first non-saple capability, wired through the same MCP seam every other capability uses - the "prove general-purpose" exit clause is met.
- **Non-saple capability (`mcp/files/`):** a second, unrelated stdio MCP server (run with `tsx`, no build step, exactly like `saple-bridge-control`) exposing three tools - `list_files`, `read_file`, `write_file` - over a single allowed folder. This is the concrete proof of §2's "add a server, not a plugin system": the agent core, the approval gate, both brains, the settings surface, and the privacy model all absorbed it as **config, not new wiring**.
- **Path containment (`mcp/files/paths.ts`, §5 "path containment & canonical-file whitelist"):** the one security-critical seam is a side-effect-free `resolveWithin`/`isWithin` pair (kept separate from `server.ts` so it unit-tests without a root). `path.resolve` normalizes `..` away and the canonical-root prefix check (with a separator guard so `/root-evil` can't pass as inside `/root`) rejects both traversal and absolute-path escapes; existing targets and a write's parent dir are additionally `realpath`'d to defeat a symlink inside the root. Reads cap at 100 KB so a voice reply can't be flooded. Containment is unit-tested (5 cases) and a live MCP-client smoke rejected `../../../etc/passwd`.
- **Gated by class, not by model (`agent/policy.ts`):** `write_file` is classified **destructive** (an external effect - overwrites a file), so it routes through the same execution-layer approval gate as `spawn_agents`/`close_terminal` - the brain proposes, June's core decides, so it holds regardless of provider (§5). `read_file`/`list_files` are **observe** and run automatically. Classification + the "Write file X" confirmation string are unit-tested.
- **Attached through the existing seam (`agent/core.ts`):** `createJuneAgent({ filesRoot })` merges `filesMcpServer(root)` into the same `mcpServers` map as saple-bridge-control, so **both** brains pick it up - Claude via the Agent SDK's `mcpServers`, the OpenAI-compat brain via its MCP client `#connect` - with zero brain-specific code.
- **Opt-in, one folder, honest privacy (`settings.ts` `FilesConfig`, `SettingsPanel.tsx` Capabilities, `agent_runner.rs` `files_env`, `run-once.ts`):** off by default - the filesystem is exposed only when the user enables it and names one folder. `agent_runner.rs` passes `JUNE_FILES_ROOT` to the run-once child **only** when enabled + a root is set; `run-once.ts` attaches the capability from that env. Because it is **local (no network)**, it is offline-safe: no privacy mode blocks it, so a Strict-offline session can still read and write local files - the honest inverse of the cloud stages Strict offline disables.
- **Gates green:** `typecheck` / `lint` / `test` (48 JS, +6: 5 containment, 1 policy) and `cargo check` / `clippy -D warnings` / `test` (7 Rust) all pass; production `vite build` bundles both faces. Live MCP-client smoke: `list_files` → `read_file` → `write_file` (creating a subfolder) → read-back all succeeded; the containment escape was rejected as an error, not followed.
- **Remaining (the deferred hardening tail, per the plan):** the recovery drills (killed June / bridge / Claude-Codex process, duplicate requests, partial batches, expired approvals, provider downtime, slow voice stages, app upgrade; a June restart restoring the same observable state via `observe` resume), structured redacted logs, diagnostics export, the accessibility pass, packaging into an installer, auto-update, and end-to-end latency measurement (acceptance / execution / spoken-response). Also deferred: wrapping artemis for headless missions, and bundling the Node core as a sidecar binary instead of `npx tsx` (the `ponytail:` note in `agent_runner.rs`). These are ops/hardening workstreams that add no capability code; the second exit clause ("an installable build recovers safely from every drill") lives entirely here.

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
