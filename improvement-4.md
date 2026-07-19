# June - Improvement Plan #4 (merged roadmap: Phases 10-19)

**Date:** 2026-07-19
**Merges:** `improvement-1.md` (code review + engineering foundation, phases A-F) and `improvement-2.md` (BridgeAgent-inspired product direction, phases 10-19). This document supersedes both as the working roadmap; the source documents stay untouched as references.
**North star (from improvement-2, confirmed by the owner):** June is a **general local-first voice agent / agentic environment**. saple-bridge becomes one optional capability among many, not the core. Every capability is an MCP server, every action routes through the policy gate, every feature respects the privacy modes.

**The merge rule:** improvement-2 had the right destination but skipped the foundation - it ignored the review's safety holes and had no persistent session, no latency target, and no audit trail, while its own later phases (unattended runs, watch loops, dictation injection, computer-use) multiply the blast radius of exactly those holes. So: foundation first (10-12), decoupling and hands-free next (13-16), autonomy last (17-19), with the audit log pulled all the way forward because every unattended feature stands on it.

Numbering continues PLAN.md (which ends at Phase 9). The Phase 9 hardening tail items are absorbed here (packaging and drills land in Phase 16).

---

## Provenance map

| Merged phase | From | Notes |
|---|---|---|
| 10 Foundation fixes | improvement-1 A + review findings | improvement-2 had no equivalent; hard prerequisite for everything |
| 11 Persistent session + memory | improvement-1 B (+ audit log pulled from F3) | improvement-2's missing multiplier; prerequisite for 14, 17, 18, 19 |
| 12 Local voice stack | improvement-1 C reconciled with improvement-2 Phase 10 | Moonshine v2 primary (streaming), whisper-rs kept as an alternate impl; download-on-demand UI from improvement-2 |
| 13 Generic MCP client | improvement-2 Phase 12 + improvement-1 E7/E1-E6 | Moved up: it is the decoupling step the north star hinges on |
| 14 Hands-free voice UX | improvement-1 D | Depends on 11's in-loop gate; absent from improvement-2 |
| 15 Transcript quality + dictation | improvement-2 Phases 11 + 16 | With an explicit injection-safety rule improvement-2 lacked |
| 16 Trust & shipping | improvement-1 F + PLAN Phase 9 tail | Tokens, observe() resume, packaging, installer, latency dashboard |
| 17 Task memory + screen grounding | improvement-2 Phases 13 + 14 | Lessons = BridgeAgent's playbook trick (verified real) |
| 18 Autonomy: scheduled runs + watch loops | improvement-2 Phases 15 + 17 | Gated on 16 (packaging) and the audit log |
| 19 Missions & platform completion | improvement-2 Phases 18 + 19 | Computer-use stays requirement-gated |

---

## NOW

### Phase 10 - Foundation fixes (~2-3 days)

Goal: the known holes are closed before any surface grows.

- **10.1 Fail-closed policy** (`agent/policy.ts` + tests): `send_to_terminal` -> destructive (a `\n` in `data` executes commands), `assign_task` -> expensive; unknown actions default to **gated**, with a per-server default-class map so capabilities can declare observe-class tools without core edits.
- **10.2 Transcript off the command line** (`agent_runner.rs`, `run-once.ts`): transcript becomes the first JSONL line on the stdin channel the runner already holds; the `cmd /C` argument path (Windows command injection) is deleted.
- **10.3 Voice privacy at the execution boundary** (`stt.rs`, `tts.rs`): Rust refuses cloud STT/TTS under on-device privacy modes - same rule the brain already gets.
- **10.4 Claude tool-result correlation** (`claude-brain.ts`): map `tool_use.id -> name` so results carry the real action and batch counts render on the default brain.
- **10.5 Live settings propagation**: emit `settings://changed` on save; the widget reloads wake/TTS/privacy without an app restart.
- **10.6 Key gate only when needed**: don't demand an OpenAI key when the selected stack doesn't use OpenAI or voice is blocked by mode.
- **10.7 Audit log v1** (pulled forward from improvement-1 F3): structured JSONL per tool call - name, params (redacted per privacy mode), class, gate decision, approver (click/policy/timeout), timestamp, turn id. Everything in phases 17-19 stands on this.
- **10.8 Small fixes**: wake-listener failure backoff; `audio/mpeg -> .mp3`; drop dead `JUNE_BRAIN_EFFORT`; dedupe `listTools()`; UTF-8-safe read truncation.
- **10.9 The live mic round-trip check** (pending since Phase 4): hold PTT, speak, hear the streamed answer, interrupt mid-sentence.

**Exit:** injection repro cannot execute; a spoken `send_to_terminal` prompts for approval; settings apply live; batch counts render on Claude; the audit log records a full turn.

**Status (2026-07-19): implemented.** All of 10.1-10.8 landed; 10.9 stays a manual GUI check (below).

- **10.1** `agent/policy.ts`: `classify` is now fail-closed - a named action wins, then a per-server default (`SERVER_DEFAULT_CLASS`, the seam Phase 13 writes to), then `destructive` for anything unknown (was `reversible`). `send_to_terminal` -> destructive, `assign_task` -> expensive, `open_browser` pinned reversible. `serverOf()` added; both brains pass the server to `classify`. Tests updated + added.
- **10.2** Transcript moved off argv onto the stdin channel as the first JSONL line (`{"transcript":...}`); `agent_runner.rs` writes it before handing stdin to the approval channel, `run-once.ts` reads it via a single shared reader. **Deviation:** the `cmd /C npx` spawn is *kept* on Windows (npx is a `.cmd` shim that cannot be `CreateProcess`'d directly), but it is now injection-safe because no user data reaches argv - the root cause (untrusted text in the command line) is removed, which is the real fix. Verified headlessly: an argv-supplied "transcript" is ignored; only the stdin line is used.
- **10.3** `stt.rs`/`tts.rs` refuse cloud STT/TTS under `local-voice`/`strict-offline` (`settings::cloud_voice_blocked`), so audio/reply text never leaves the machine even if the webview asks.
- **10.4** `claude-brain.ts` maps `tool_use.id -> action` so `onToolResult` carries the real action (was `""`); batch counts render on the default brain.
- **10.5** `save_settings` emits `settings://changed`; `VoicePanel` reloads wake/TTS/privacy live (no restart).
- **10.6** The OpenAI key gate fires only when the chosen voice stack actually uses the key (`voiceNeedsOpenAiKey`) and voice isn't blocked by the mode.
- **10.7** Audit log v1: `run-once.ts` emits one `{"t":"audit"}` line per tool call (name, class, params redacted per privacy mode, decision, approver: auto/policy/click/timeout/closed); `agent_runner.rs` stamps the turn and appends to `<app_data_dir>/audit.jsonl`. The single gate choke point audits gated *and* ungated calls.
- **10.8** wake-listener STT-failure backoff (`wakeBackoffUntil`, capped 30s); `audio/mpeg -> .mp3`; dead `JUNE_BRAIN_EFFORT` dropped; `listTools()` fetched once per server (was twice); UTF-8-safe read truncation (`utf8SafeEnd`, never splits a multi-byte char).
- **10.9 (pending, manual):** the live mic round-trip (hold PTT, speak, hear streamed answer, interrupt mid-sentence) needs the GUI + a real brain/mic and cannot be driven headlessly. Left for a manual pass. Everything else is covered by unit tests (55 TS + 7 Rust green), typecheck, `eslint`, and `cargo clippy`.

### Phase 11 - Persistent agent session + memory (~1 week) - the multiplier

Goal: June stops being per-utterance amnesiac and per-turn slow.

- **11.1 Resident agent process** (`agent/serve.ts` replacing per-turn `run-once.ts`): JSONL over the existing stdio pair - requests `{run, approve, cancel, reset}`, events `{text, tool, result, approval, final, error}` tagged by turn. Respawn on crash with backoff; per-turn watchdog. Deletes the `cmd -> npx -> tsx -> MCP-connect` chain from every turn; MCP connections stay warm.
- **11.2 Conversation memory**: Claude brain holds one `query()` open in streaming-input mode (preferred - keeps `canUseTool` in-loop for Phase 14's spoken approvals); fallback is stable-cwd session `resume` (resume is cwd-keyed - pin it). OpenAI-compat brain retains its `messages` array. New conversation on ~10 min idle (setting) + explicit "new conversation" in both faces. `persistSession: false` under strict privacy modes. (SDK note: the experimental V2 session API was removed in 0.3.142 - build only on `query()` + session options.)
- **11.3 Real turn cancel**: barge-in/cancel aborts the in-flight turn (SDK abort; AbortController in the OpenAI loop). No more orphaned spending processes.
- **11.4 Long-term memory**: one user-editable `june-memory.md` injected into the system prompt, written via the Anthropic memory-tool pattern, file-backed and path-contained exactly like `mcp/files`. Settings surface: "what June remembers" + clear. No vector store.
- **11.5 Latency instrumentation**: per-turn capture-end -> transcript -> first token -> first audio -> total; P50/P95 in Diagnostics. Target line: 800ms median voice-to-voice once Phase 12 lands.

**Exit:** "open two claude agents" then "now two codex ones as well" works; second-turn overhead < 300ms before first token; barge-in provably stops token spend; June recalls a preference stated yesterday.

**Status (2026-07-19): 11.1 + 11.2 + 11.3 implemented.** 11.4-11.5 pending.

- **11.1** landed prior (commit `944ba70`): `agent/serve.ts` resident process, both brains long-lived (Claude holds one `query()` in streaming-input mode; OpenAI-compat keeps its `messages` array warm), `agent_runner.rs` respawn-on-crash + per-turn watchdog. `cancel()`/`reset()`/`dispose()` on both brains; `persistSession: false` under `strict-offline`. This already covered the streaming-session and `persistSession` parts of 11.2.
- **11.2** completed here - the two remaining pieces (idle auto-reset + explicit "new conversation" in both faces):
  - **Idle auto-reset** is lazy-on-next-turn, not a background timer: `agent_runner.rs::run_agent` records `last_activity` per turn and, if the gap to the next turn exceeds `conversationIdleMinutes` (settings, default 10; 0 disables), resets the conversation *before* that turn. Behaviorally identical to a 10-min timer (nothing observes the conversation between turns), with no timer thread. The idle rule is a pure `idle_exceeded()` unit-tested for the None/disabled/threshold cases.
  - **Explicit "new conversation"** is a `new_conversation` Tauri command that writes `{"type":"reset"}` to the resident (drops brain memory), clears the shared session log + pending approval, and broadcasts `agent://reset`. A button surfaces it in **both faces**: the full-app header (`AppWindow`, which clears its transcript on `agent://reset`) and the widget header (`VoicePanel`, which tears down any in-flight capture/speech first, same teardown as Cancel).
  - Settings gain `conversationIdleMinutes` (typed + coerced, non-negative int) with a "New conversation after N minutes idle" control in a new Conversation section. Read fresh per turn on the Rust side, so a change needs no restart.
  - **Deviation from the doc:** the SDK `resume` fallback was not needed - the streaming-input `query()` session from 11.1 carries conversation memory directly, so there was nothing to fall back to. No `resume`/cwd-pinning code was added.
  - Verified: 59 TS tests + 9 Rust tests (incl. the new `idle_exceeded` case), typecheck, eslint, clippy all green. Live GUI round-trip (speak, pause 10+ min, confirm the next command starts fresh; click "New conversation" in each face) stays a manual pass - it needs a real brain and mic.
- **11.3** completed here - real turn cancel wired end-to-end. The abort *mechanism* already existed from 11.1 (`ClaudeBrain.cancel()` -> `query.interrupt()`; `OpenAiCompatBrain.cancel()` -> `AbortController.abort()` on the in-flight completion) and serve.ts already had a `{"type":"cancel","turn":N}` handler, but **nothing ever sent it**: the widget's `bargeIn()`/`cancel()` only bumped the local turn ref and abandoned the turn, so the resident kept generating tokens to completion (the exact "orphaned spending process" 11.3 targets). The barge-in-with-new-command path preempted via `handleRun`, but a plain Cancel - or a barge-in that captured no follow-up command - left the turn spending unheard.
  - New `cancel_agent(turn)` Tauri command (`agent_runner.rs`, registered in `lib.rs`) writes the cancel request to the resident; best-effort, since serve.ts interrupts only if `turn` is still active and self-denies its pending gate, so cancelling a finished turn or with no resident is a harmless no-op.
  - `session.ts` gains `cancelAgent(turn)`; `VoicePanel`'s `bargeIn()` and `cancel()` both call it **before** bumping `turnRef` (the dying turn is the current ref value), so a barge-in or Cancel aborts the in-flight turn on the backend immediately instead of only locally.
  - **No new dependency, no new machinery** - this is purely the missing wire between the existing frontend intent and the existing backend abort. The `run_agent` await still resolves cleanly (an interrupted brain emits a `final`), so nothing hangs.
  - Test: `openai-brain.test.ts` now drives `cancel()` headlessly against a `fetch` that only settles on its abort signal, proving the completion aborts, `run()` returns `{text:"",isError:false}` (no user-facing error, no spoken text), and the turn rolls back - a direct check that barge-in stops token spend.
  - Verified: 60 TS tests + 9 Rust tests, typecheck, eslint, clippy all green. Live GUI barge-in (interrupt June mid-sentence, confirm token spend stops) stays a manual pass - it needs a real brain and mic.

### Phase 12 - Local voice stack (~1-2 weeks)

Goal: Local-voice and Strict-offline become real configurations instead of "mic off". All inference in the existing Rust process via ONNX Runtime - one dependency, no Python sidecars (the Handy blueprint: same Tauri+Rust stack, in-process ORT). Models are **download-on-demand with checksum + progress UI** (improvement-2's addition), never bundled in the installer. ~650MB full-stack footprint.

- **12.1 Silero VAD v5** (~2MB ONNX, `silero-vad-rs`/`vad-rs`) replaces the RMS gate for endpointing and barge-in; interruption fires on N consecutive speech-probability frames.
- **12.2 Local wake word**: openWakeWord "Hey June" (~200KB ONNX, trained on synthetic speech; A/B the LiveKit wakeword trainer), running in the Rust audio loop gated by Silero. Kills cloud phrase-spotting and its per-burst spend; wake becomes offline-safe.
- **12.3 Local STT** behind the existing `SttProvider` seam: **Moonshine v2 streaming** (medium 245MB `.ort`, MIT, ~107ms streaming updates, beats whisper-large-v3 WER) as primary; **Parakeet-TDT-0.6b-v3 int8** (CC-BY-4.0) as the accuracy toggle; **whisper-rs** (improvement-2's pick) acceptable as a third alternate impl but it is batch/pseudo-streaming - it must not displace the streaming primary. Model-size picker per improvement-2.
- **12.4 Local TTS**: Kokoro-82M via Kokoros (pure Rust) or kokoro-onnx, reusing the sentence streamer unchanged; verify the phonemizer license path (espeak-ng is GPL); evaluate Supertonic (official Rust binding, RTF ~0.3x CPU) as the alternate.
- **12.5 Semantic endpointing**: smart-turn-v3 int8 (~12ms CPU) - Silero flags silence, smart-turn decides finished vs mid-thought.
- **12.6 Streaming transcription UX**: live interim transcript while speaking; optional brain pre-warm on the interim.
- **12.7 Registry flip**: `offlineSafe: true` / `available: true` on the new providers - privacy-mode enforcement already exists and needs no changes (the design earns its keep here).

**Exit:** full voice turn (wake -> STT -> brain via Ollama -> TTS) with the network disabled; P50 voice-to-voice under ~1s with a fast brain.

---

## NEXT

### Phase 13 - Generic MCP client & capability manager (~1 week) - the decoupling step

Goal: users add capabilities without June shipping them; saple-bridge becomes list entry #1, not the core.

- **13.1 Add-any-server UI**: stdio command or URL, per-server enable toggle, per-server `offlineSafe` flag feeding the existing privacy enforcement.
- **13.2 Policy integration**: tools from unknown servers default to **approval-required** (Phase 10.1's default makes this automatic); the user can promote a specific tool to auto-run after seeing it once; per-server class overrides persist in settings.
- **13.3 Decoupling**: `saple-bridge-control` and `mcp/files` become the first two entries in this list - no special-case wiring left in `agent/core.ts`.
- **13.4 Curated catalog presets** (maturity-ranked from research): SDK built-in WebSearch/WebFetch (Claude brain, config-only) + Brave Search MCP (OpenAI-compat brains); saple-memory; Google Workspace (taylorwilsdon/google_workspace_mcp - `send`-class tools gated as external effects); official Home Assistant MCP (intent-scoped, naturally sandboxed); lightweight Spotify MCP; microsoft/playwright-mcp flagged **on-demand only** (~100k tokens/task - never in the default voice tool surface).
- **13.5 Operational hygiene**: pinned server versions (npx supply-chain vetting - typosquatted MCP servers are a real, observed attack), health probe per server, tool inspector.

**Exit:** add a GitHub MCP server from settings, list issues by voice, the gate fires on a write - zero June code changes.

### Phase 14 - Hands-free & conversational voice UX (~1 week)

Goal: the full loop with zero keyboard or mouse. Rides on 11's in-loop gate and 12's local wake/VAD.

- **14.1 Auto-accept with countdown** (setting; manual stays default): review card auto-sends after ~3s; any interaction pauses it.
- **14.2 Spoken approvals**: June speaks the repeat-back with exact parameters; reply matched by a **strict local phrase matcher** (yes/no/confirm/cancel) - never the LLM, never satisfiable by tool output; ~8s timeout = deny, announced aloud. Tiering: expensive = spoken yes OK; destructive/external = click required.
- **14.3 Follow-up mode**: mic reopens ~5-8s after each reply, no wake word (opt-in) - with 11.2's memory this is what turns June into a conversation.
- **14.4 Backchannel acknowledgement**: a brief spoken "on it" when a turn starts tool calls.
- **14.5 Interruption polish**: barge-in on Silero speech probability; June never interrupts a user mid-pause (smart-turn).

**Exit:** wake -> command -> spoken approval -> execution -> follow-up, hands never touching the keyboard; a denied spoken approval provably blocks the action.

### Phase 15 - Transcript quality & system-wide dictation (~1 week)

Goal: June earns daily use even when no agent is needed (improvement-2's best product insight).

- **15.1 Auto-edit pass**: a cheap LLM pass (selected brain, local-capable) strips filler, fixes punctuation, formats lists - before the review gate; settings toggle.
- **15.2 Personal dictionary**: corrections made in the review gate auto-add terms; the dictionary biases the STT prompt and the edit pass; persists in June's data dir; user-editable.
- **15.3 Voice snippets**: a spoken cue expands to saved text ("insert my intro").
- **15.4 Dictation mode**: PTT injects the cleaned transcript into the focused app (enigo/SendInput). **Safety rule improvement-2 lacked: injection happens only as the direct result of a user-held PTT press, never agent-initiated, with a visible on-screen indicator while active.** This keeps it on the right side of PLAN §8's "OS-wide actions stay unavailable" line - the user is the actor, June is the keyboard.
- **15.5 App-aware formatting**: reads the focused window **title only** (no content scraping), opt-in, to pick tone (Slack casual, email formal).

**Exit:** dictate a messy paragraph into Notepad and a browser field -> clean text; a corrected name sticks next session.

### Phase 16 - Trust & shipping (~1-2 weeks; absorbs the PLAN Phase 9 tail)

- **16.1 Bridge-side one-time approval tokens**: mint on June-side approval; bridge verifies action+args+nonce+expiry before executing gated commands (`ApprovalToken` already frozen in the contract). Closes the "any local process with the discovery token bypasses the gate" hole.
- **16.2 `observe()` resume + recovery drills**: restart restores the roster from the last acknowledged sequence; the full drill matrix (killed June/bridge/agent, duplicate requests, partial batches, expired approvals, provider downtime, app upgrade).
- **16.3 Injection hardening codified**: tool results are untrusted input (never satisfy approvals - keep structural); full-parameter display/speech before dangerous acts; pinned MCP versions.
- **16.4 Sidecar packaging**: bundle the agent per Tauri v2 `externalBin` - prefer Bun `--compile`, fall back to node.exe + esbuild single-file bundle as resources; avoid pkg/Node SEA. **Gate: prove the Agent SDK's subprocess spawn (`query()` e2e) from the compiled binary before locking the compiler.** `CREATE_NO_WINDOW` on Windows spawns.
- **16.5 Installer + auto-update**, diagnostics export, accessibility pass, structured redacted logs (extends 10.7).
- **16.6 Latency dashboard**: P50/P95 voice-to-voice against the 800ms target, per-stage breakdown from 11.5.

**Exit:** an installable build recovers safely from every drill; a fresh machine goes installer -> spoken command without a dev toolchain.

---

## LATER

### Phase 17 - Task memory & screen grounding

Goal: June gets better at repeated tasks and can see what you see (both opt-in).

- **17.1 Post-run lesson writer** (BridgeAgent's playbook trick, verified real): the agent appends a short markdown lesson after each run - capped count/size, user-visible and editable, stored next to `june-memory.md`.
- **17.2 Pre-run recall**: top-k relevant lessons injected into the system prompt - **keyword/recency match, no vectors** until the file corpus provably outgrows it.
- **17.3 saple-memory MCP** attaches via Phase 13 machinery - a config entry, no code.
- **17.4 Screen context tool**: opt-in observe-class tool - screenshot of the **active window only** + local OCR (Windows.Media.Ocr). Local-only, so it stays available under Strict offline; screenshots are never persisted to logs; the audit log records that a capture happened, not its content.

**Exit:** the same task done twice uses prior lessons the second time; "what does this error on my screen mean" gets a grounded answer.

### Phase 18 - Autonomy: scheduled runs & watch loops (requires 16.4 packaging + 10.7 audit log)

Goal: June works while you don't - without ever acting beyond its leash.

- **18.1 Scheduler**: Rust-side cron expressions launch headless agent sessions via the bundled sidecar; results land in the session log; OS notification on completion.
- **18.2 The unattended rule**: approval-required actions **pause the run and notify - never auto-approve, no blanket session approvals**. The audit log is the reviewable record of everything an unattended run did.
- **18.3 Trigger framework** (BridgeAgent's production-watch pattern, generalized): file-watch, localhost webhook receiver, log tail. A trigger opens an investigation session with the trigger payload as context. **Trigger payloads are untrusted input** - the 16.3 injection rules apply; a webhook body can never approve anything or reach a terminal un-gated.

**Exit:** a daily 9am briefing completes unattended and notifies; a webhook opens a gated investigation whose every action is in the audit log.

### Phase 19 - Missions & platform completion

Goal: June stands alone as a general agentic environment.

- **19.1 Missions**: a user-stated outcome decomposes into a verifiable task list; sequential sessions per task; progress in a simple task-board UI (both faces can show mission state).
- **19.2 Composable toolsets**: only mission-relevant MCP servers load per session (BridgeAgent's toolsets idea - their marketing says 25 integrations, not 57; the concept holds regardless) - keeps the per-turn tool surface lean, which voice latency needs anyway.
- **19.3 Zero saple-\* dependencies required to run**: saple-bridge is an optional Phase 13 catalog entry; June installs and works on a machine that has never seen saple.
- **19.4 Computer-use MCP**: **only if a real requirement appears** (unchanged from PLAN §8's discipline), opt-in, destructive-class by default, and only after 16.3's hardening and the audit log have been proven in the field. It is the top prompt-injection amplifier in current guidance; Playwright covers the browser subset far more safely.

**Exit:** June runs standalone with no saple installed; a mission completes across multiple sessions with a reviewable board and audit trail.

---

## Deliberately not doing

- **Cloud-side execution** ("runs with laptop closed") - against local-first. BridgeAgent's headline feature is exactly this; June's differentiation is the opposite.
- **Stealth/undetectable overlays** - against honest-by-design.
- **Session-wide blanket approvals** - per-action gating stays, including for scheduled runs.
- **Generic Windows input control as an agent capability** (MCPControl-style raw input injection) - dictation injection (15.4) is user-initiated only; the agent never drives the keyboard/mouse.
- **Vector memory stores** - markdown memory + lessons until they provably outgrow keyword recall.
- **Computer-use before a real requirement** (19.4's gate).

## Top risks (merged)

1. **Agent SDK inside a compiled sidecar** (16.4): the SDK spawns its bundled CLI as a subprocess; bundlers can break this silently. Spike the compiled-binary `query()` e2e early; node.exe-as-resource always works.
2. **Session resume is cwd-keyed** (11.2): pin cwd explicitly; test across restarts.
3. **Kokoro phonemizer licensing** (12.4): espeak-ng is GPL; use a clean-G2P binding or Supertonic.
4. **Wake-word false triggers** (12.2): A/B two trainers against a recorded test set; keep the sensitivity slider; Silero gating.
5. **Unattended runs amplify any gate weakness** (18): hence the hard ordering - 10.1's fail-closed default and 10.7's audit log land months before 18 does.
6. **Voice E2E test flakiness** (all): recorded-audio fixtures feeding the Rust pipeline directly + golden transcripts; live-mic checks stay manual but scripted.

## Acceptance scenario (the general-purpose upgrade)

1. Fresh machine, no saple installed: installer -> "Hey June" (fully local) -> "what's on my calendar today" via the Google Workspace entry the user added in settings - answered, hands-free.
2. "Open five claude agents and four codex agents" (saple-bridge attached as an optional capability): June repeats counts and cost class aloud; the user says "yes"; executed once; counts reported from bridge results; follow-up within 8s, no wake word.
3. Strict offline (switched live, no restart): full spoken round-trip via local wake/STT/TTS and an Ollama brain, zero network; the files capability still works.
4. Dictation: PTT into a browser text field -> cleaned, dictionary-corrected text appears; nothing was injected that the user didn't speak while holding the key.
5. A daily 9am briefing run completes unattended; a gated action inside it paused and notified instead of running; the audit log shows every action, parameter, and approver.
6. P50 voice-to-voice < 1s, P95 < 2s on the latency dashboard; restarting June (or the bridge) restores the same observable state.
