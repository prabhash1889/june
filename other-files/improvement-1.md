# June - Improvement Plan #1

**Date:** 2026-07-19
**Basis:** full code review of the june repo (all gates verified green: typecheck, 48/48 vitest, clippy `-D warnings`, 7/7 cargo tests) plus two research passes: (1) local voice pipeline tech, (2) agent capability / memory / safety patterns, both current as of mid-2026.
**Scope:** what is wrong today, what to build next, in what order, and why.

---

## 1. Review verdict

The architecture is sound and honestly implemented: the provider seams (`Brain` / `SttProvider` / `TtsProvider`), the frozen bridge contract, and the execution-layer approval gate are all real in code, not just in PLAN.md. The engineering discipline (atomic settings writes, keychain isolation, WebView2 workarounds, turn-tagged barge-in channel) is above average.

But the review found **2 safety holes, 1 security bug, and 4 correctness/UX bugs**, plus a set of honest-but-defining gaps between the pitch ("local-first voice agent") and reality (100% cloud voice, no conversation memory, multi-second per-turn latency).

### 1.1 What is correctly implemented (verified against source)

| Area | Evidence |
|---|---|
| Approval gate in the execution layer | Both brains route every tool call through the same `ToolGate` before dispatch: Claude via `canUseTool` (`agent/claude-brain.ts:45`), OpenAI-compat inside its own loop (`agent/openai-brain.ts:140`). Fails closed: 120s timeout denies, closed stdin denies, `resolve_approval` validates id + routes to the owning turn (`agent_runner.rs:388`) |
| Path containment (`mcp/files`) | Canonical root via `realpathSync`, separator-guarded prefix check, realpath re-check of existing targets and write parents (symlink defense), 100KB read cap, unit tested. No escape found |
| Secrets never cross IPC | No `get_api_key` command exists; keys read only in Rust at call sites; renderer-facing keychain commands validate the service-name convention |
| Contract layer | Frozen error codes/actions, runtime validators, golden JSON examples, tests run without a bridge |
| Brain privacy enforcement | `run-once.ts:130` refuses a networked brain under a forbidding mode at the execution boundary, not just in the UI |
| Cross-window session | Seq-stamped capped event log, replay-then-live with buffering + dedup, StrictMode-safe (`AppWindow.tsx`) |
| Settings | Temp-file + rename writes, typed coercion with per-field fallbacks, merge-over-raw-bag saves |
| Provider honesty rule | Unwired local providers are visible but not selectable |

### 1.2 What is wrong

**Safety / security (fix first):**

- **S1 - `send_to_terminal` and `assign_task` are ungated; unknown actions default to auto-run.** `agent/policy.ts:39` classifies any unlisted action as `reversible` (automatic). `send_to_terminal` writes raw text to a live terminal; a `data` payload containing `\n` executes whatever precedes it - arbitrary command execution with no human yes, contradicting PLAN §5 ("external effect: explicit approval"). `assign_task` directs a paid agent to arbitrary work ungated. The fail-open default means every future MCP server's mutating tools run silently until someone remembers to classify them.
- **S2 - Transcript passes through `cmd /C` on Windows (command injection).** `agent_runner.rs:214` spawns `cmd /C npx tsx run-once.ts "<transcript>"`. Rust escapes per MSVC rules; `cmd.exe` does not parse by those rules. A transcript containing quotes/`%`/`&` (spoken, mis-transcribed, or typed into the editable review card) can break quoting and execute commands. Rust deliberately blocks `.bat`/`.cmd` spawning for this exact class (CVE-2024-24576); explicit `cmd /C` opts out of that protection.
- **S3 - Bridge-side one-time approval tokens not implemented** (known/deferred). `ApprovalToken` is frozen in the contract but never minted or verified. Any local process that reads the discovery record's bearer token can command the bridge with no approval; June's gate only guards June's own path.
- **S4 - Voice-stage privacy is UI-only.** The brain is checked at the execution boundary; `transcribe`/`synthesize` in Rust will happily call OpenAI under strict-offline. Only `VoicePanel` politely disables the mic.

**Correctness / UX bugs:**

- **C1 - Tool results never attach to tool entries for the default (Claude) brain.** `claude-brain.ts:95` emits `onToolResult(actionOf(""), ...)` - always the empty string, because the SDK's `tool_result` block carries an id, not a name, and nothing maps it back. `AppWindow.tsx:94` correlates by action name, so the "started 5 of 5" batch summaries never render on the default brain. (The OpenAI brain passes the real action and works.)
- **C2 - Settings changes never reach the running widget.** `VoicePanel` loads settings once on mount; the widget window never remounts. Enabling wake word, changing TTS voice, or switching privacy mode has no effect until app restart - contradicting Phase 8's live toggle claim.
- **C3 - Hands-free is not hands-free.** After "Hey June" + speech, the review card still requires a mouse click on "Send to June". Phase 8's exit ("talk to June without touching the keyboard") is unreachable end to end.
- **C4 - The widget demands an OpenAI key before doing anything**, even under strict-offline where cloud voice is blocked anyway. A local-brain, no-cloud user is locked out of the default face.
- **Minor:** `settings.stt` provider/model persisted but `stt.rs` hardcodes whisper-1 (the setting is fake); `JUNE_BRAIN_EFFORT` exported and read by nobody; barged-in turns keep running with no kill switch (unbounded background token spend); wake listener retries failed transcriptions forever (bad key = silent API spam, one call per speech burst); `filename_for` maps `audio/mpeg` to `audio.mp4`; `read_file` truncation can split a UTF-8 char; `collectTools` calls `listTools()` twice per server per turn.

**Defining gaps (deferred by plan, but they are the product today):**

- **G1 - No conversation memory.** Every turn is a fresh process seeing only the current transcript. "Do that again", "and four more", any pronoun across turns - impossible. The single biggest capability gap for a conversational agent.
- **G2 - No local voice exists.** STT, TTS, and wake are all OpenAI cloud; "local-first" is aspirational; local-voice / strict-offline modes just turn voice off.
- **G3 - Per-turn latency chain:** `cmd -> npx -> tsx -> run-once -> (npx tsx per MCP server) -> SDK spawn`. Seconds of process spawning and TS transpilation before the brain sees a word. Fatal for voice UX.
- **G4 - `observe()` is never called by June.** The event-resume machinery is bridge-side only; restart recovery is unstarted.
- **G5 - The live spoken round-trip has never been manually verified** (needs mic + key), so Phases 4-8 exits are formally open.

---

## 2. Research digest (what the two research passes found)

### 2.1 Local voice stack (Windows, Tauri + Rust)

- **Blueprint exists:** [Handy](https://github.com/cjpais/Handy) (23k+ stars, MIT) is a Tauri + Rust dictation app running Whisper GGML, **Parakeet v3 via `transcribe-rs`**, Moonshine, and Silero (`vad-rs`) **all in-process in Rust** - June's exact stack, no Python sidecars.
- **STT:** **Moonshine v2 streaming** (Feb 2026, MIT, `.ort` ONNX files; medium = 245MB, 6.65% WER - beats Whisper large-v3 - ~107ms/update, built explicitly for voice agents; C API or `ort`). **Parakeet-TDT-0.6b-v3 int8 ONNX** (CC-BY-4.0) as the high-accuracy batch option. faster-whisper means a Python sidecar - skip. whisper.cpp/whisper-rs viable but not truly streaming.
- **TTS:** **Kokoro-82M** (Apache-2.0, ~80MB quantized ONNX, 54 voices) via **Kokoros** (pure-Rust, realtime) or kokoro-onnx; sentence-chunk synthesis well under 1s on desktop CPU. Watch the espeak-ng (GPL) phonemizer story. **Supertonic** (~99M, RTF ~0.3x CPU, official Rust binding, OpenRAIL-M weights) as the multilingual/faster alternative. **Piper moved to GPL-3** under its maintained fork - skip.
- **Wake word:** **openWakeWord** custom "Hey June" - trained on synthetic TTS speech (no recordings needed), community trainers produce a ~200KB ONNX in ~45min; pair with Silero VAD to cut false accepts. A/B against **LiveKit's 2026 wakeword trainer** (claims 100x fewer false positives). **Porcupine: skip** (~$6k/yr, no model export). sherpa-onnx keyword spotting is the zero-training fallback.
- **VAD / turn-taking:** **Silero VAD v5** (MIT, ~2MB ONNX, Rust crates: `silero-vad-rs` / `vad-rs`) replaces the RMS gate; run it in the Rust audio thread, not the webview. **Pipecat smart-turn-v3** (BSD-2, 8M params, ~12ms CPU int8) for semantic endpointing: Silero flags silence, smart-turn decides "actually finished" vs "mid-thought".
- **Latency consensus:** target **800ms median voice-to-voice** (>1.5s feels like a walkie-talkie). The winning moves: streaming STT partials while the user talks, semantic turn detection (saves 300-700ms of "waiting to be sure"), LLM token streaming into sentence-chunked TTS (June already has the last one). Going local deletes both ~200ms network legs; sub-800ms is achievable whenever LLM time-to-first-token < ~300ms.
- **Total local model footprint:** ~650MB (VAD 2MB + wake 0.2MB + Moonshine medium 245MB + smart-turn ~30MB + Kokoro ~330MB), all on one ONNX Runtime dependency in the existing Rust process.

### 2.2 Agent capabilities, memory, approvals, safety, packaging

- **Session memory is nearly free:** the Claude Agent SDK persists sessions automatically; `continue: true` resumes the most recent session in the cwd, `resume: <sessionId>` targets one (capture `session_id` from the init message). **Gotcha:** resume is keyed to cwd - pin a stable cwd. The experimental V2 session API was removed in SDK 0.3.142; build on `query()` + session options. **Streaming input mode** (async-generator prompt) keeps one `query()` alive across user messages with `canUseTool` handled in-loop - the enabler for spoken approvals. `persistSession: false` exists for privacy modes.
- **Long-term memory:** Anthropic's file-backed **memory tool** (`memory_20250818`) + one user-editable markdown memory file injected into the system prompt. Skip vector stores at single-user desktop scale.
- **Capability order (maturity-ranked):** (1) SDK built-in **WebSearch/WebFetch** (zero cost for the Claude brain; Brave Search MCP for the OpenAI-compat brain), (2) **Google Workspace MCP** (taylorwilsdon/google_workspace_mcp - Gmail/Calendar/Drive; email *send* is a gated external effect), (3) **official Home Assistant MCP** (intent-scoped, naturally sandboxed - safest high-wow), (4) **Spotify MCP** (lightweight variant; worst case is the wrong song), (5) **Playwright MCP on demand only** (~100k+ tokens/task - never leave attached to every voice turn). **Skip** generic Windows input control (MCPControl) and computer-use for now.
- **Spoken approvals prior art (Alexa `Dialog.ConfirmIntent`):** repeat back **all exact parameters**, accept a strict yes/no, **timeout = deny** ("silence is not consent" is an explicitly flagged attack surface), and match the reply with a **local phrase matcher, never the LLM** - the model must not be able to approve its own action, and an injected tool result must never count as approval. Tier it: high-destructive stays click-only.
- **Safety consensus (MCP spec 2026 + NSA/CISA CSI, June 2026):** classify-by-action with risk annotations is where the ecosystem went (June's design is aligned); tool results are untrusted input (indirect prompt injection is the top attack); pin MCP server versions (npm typosquatting campaigns have shipped rogue MCP servers); audit-log every tool call + params + permission decision.
- **Sidecar packaging:** Tauri v2 `externalBin` + target-triple naming. Compiler risk: the Agent SDK spawns its bundled CLI as a subprocess - **verify `query()` end-to-end from the compiled binary before committing**. Prefer Bun `--compile` or the pragmatic "ship node.exe + esbuild single-file bundle as resources" path over pkg/Node SEA (prior art of SEA working in dev and failing silently in production bundles).

---

## 3. The plan

Six phases, ordered by leverage. Each phase is independently shippable; A is prerequisite hygiene, B is the multiplier everything else compounds on, C makes the pitch true, D makes voice delightful, E grows capability, F makes it trustworthy and installable.

### Phase A - Close the holes (safety + correctness, ~1-2 days)

| # | Change | Files | Detail |
|---|---|---|---|
| A1 | Fail-closed policy | `agent/policy.ts`, `agent/policy.test.ts` | Classify `send_to_terminal` **destructive** (newline in `data` = command execution) and `assign_task` **expensive**. Flip the unknown-action default from `reversible` to **gated** (a new server's tools ask until classified). Add an optional per-server default-class map so a future capability can declare observe-class tools without core edits. Update the tests that currently pin fail-open as intended |
| A2 | Transcript off the command line | `agent_runner.rs`, `agent/run-once.ts` | Deliver the transcript as the first JSONL line on the stdin channel the runner already holds (`{"t":"run","transcript":...}`); drop the `cmd /C` argument entirely. Kills the injection surface with zero new machinery |
| A3 | Voice privacy at the execution boundary | `stt.rs`, `tts.rs` | Read `privacyMode` from settings in Rust and refuse cloud STT/TTS under modes that require on-device voice - the same rule `run-once.ts` already applies to the brain |
| A4 | Claude tool-result correlation | `agent/claude-brain.ts` | Track `tool_use.id -> name` per turn; emit the real action in `onToolResult` so `AppWindow` batch counts finally render on the default brain |
| A5 | Live settings propagation | `src/lib/settings.ts`, `VoicePanel.tsx` | Emit `settings://changed` on save; widget reloads wake/TTS/privacy config on the event. Fixes the restart-to-apply bug |
| A6 | Key gate only when needed | `VoicePanel.tsx` | Only demand the OpenAI key when the selected voice stack actually uses OpenAI and voice is allowed under the current mode |
| A7 | Small fixes | various | Wake-listener failure backoff (stop after N consecutive transcription failures); `audio/mpeg -> audio.mp3`; drop the dead `JUNE_BRAIN_EFFORT` env (or apply it where supported); dedupe `collectTools`'s second `listTools()`; UTF-8-safe read truncation |

**Acceptance:** injection repro (transcript containing `" & calc & "`) cannot execute; a spoken `send_to_terminal` prompts for approval; toggling wake word in settings takes effect without restart; batch counts render with the Claude brain.

Also do now: **the long-pending live mic round-trip check** (G5) - every phase exit since Phase 4 is waiting on it.

### Phase B - Persistent agent session + memory (~3-5 days) ** the multiplier**

| # | Change | Detail |
|---|---|---|
| B1 | Long-lived agent process | Replace per-turn `run-once.ts` spawning with one resident `agent/serve.ts` process speaking JSONL over the stdio pair `agent_runner.rs` already manages: requests `{run, approve, cancel, reset}`, events `{text, tool, result, approval, final, error}` tagged by turn. Respawn on crash with backoff; per-turn watchdog timeout. Deletes the `cmd -> npx -> tsx -> MCP-connect` chain from every turn (G3): after warmup, turn overhead drops from seconds to ~nothing, and MCP server connections stay warm |
| B2 | Conversation memory | Claude brain: pin a stable `cwd`, capture `session_id`, use `resume` (or hold one `query()` open in streaming-input mode - preferred, since it also keeps `canUseTool` in-loop for Phase D spoken approvals). OpenAI-compat brain: retain the `messages` array in-process. New conversation on idle timeout (default ~10 min, setting) + an explicit "new conversation" action in both faces. Honors the §4 "session memory on/off" setting; `persistSession: false` under strict privacy modes |
| B3 | Real turn cancel | Barge-in / cancel aborts the in-flight turn (SDK abort; `fetch` AbortController in the OpenAI loop) instead of orphaning a spending process. Removes the unbounded background token spend |
| B4 | Long-term memory | One user-editable `june-memory.md` (preferences, device names, standing instructions) injected into the system prompt; writes via the Anthropic memory tool pattern, file-backed and path-contained exactly like `mcp/files`. Surfaced in settings ("what June remembers", clear button). No vector store |
| B5 | Latency instrumentation | Per-turn timings recorded in the session log: capture end -> transcript, transcript -> first token, first token -> first audio, total voice-to-voice. P50/P95 in Diagnostics. Target line: 800ms median once Phase C lands |

**Acceptance:** "open two claude agents" then "now two codex ones as well" works as a follow-up; second-turn overhead < 300ms before first token (excluding model time); barge-in provably stops token streaming; June recalls a preference stated yesterday.

### Phase C - Local voice stack (~1-2 weeks) ** makes "local-first" true**

All inference in the existing Rust process via ONNX Runtime (`ort` crate) - one runtime dependency, no Python, no per-engine processes. Follow Handy's proven architecture (same stack). ~650MB total model footprint, downloaded on demand per stage, not bundled in the installer.

| # | Change | Detail |
|---|---|---|
| C1 | Silero VAD v5 in Rust | Replace the RMS `SilenceDetector` for endpointing and barge-in with Silero (~2MB ONNX, `silero-vad-rs`/`vad-rs` pattern). Barge-in fires on N consecutive speech-probability frames, not an energy threshold - the Pipecat/LiveKit default. Smallest change, improves everything downstream |
| C2 | Local wake word | Train "Hey June" with openWakeWord (synthetic-speech training, ~200KB ONNX); A/B the LiveKit wakeword trainer. Run in the Rust audio loop gated by Silero. Kills cloud phrase-spotting entirely: wake becomes offline-safe, always-listening becomes honest, and the per-burst Whisper spend disappears |
| C3 | Local STT | `SttProvider` impl #2: Moonshine v2 streaming (medium, 245MB, MIT) via C API or `ort` - streaming partials for live transcription. Parakeet-TDT-0.6b-v3 int8 ONNX as the "high accuracy" toggle. Registry entries flip to `available: true`; the fake STT model setting (minor bug) becomes real |
| C4 | Local TTS | `TtsProvider` impl #2: Kokoro-82M via Kokoros (pure Rust) or kokoro-onnx, reusing the existing sentence-chunk streamer unchanged. Verify the phonemizer license path (espeak-ng is GPL; Moonshine wrote its own G2P for this reason). Evaluate Supertonic (official Rust binding) if CPU RTF or multilingual matters |
| C5 | Semantic endpointing | smart-turn-v3 int8 (~12ms CPU): Silero flags a silence candidate, smart-turn classifies complete vs mid-thought, incomplete extends the window. Saves 300-700ms of "waiting to be sure" per turn |
| C6 | Streaming transcription UX | Show live interim transcript while the user speaks (Moonshine partials); optionally pre-warm the brain prompt on the interim and discard if it changes |

**Acceptance:** strict-offline mode completes a full spoken round-trip (wake -> STT -> local brain via Ollama -> TTS) with zero network; the privacy tiers finally describe real configurations; P50 voice-to-voice under ~1s with a fast brain.

### Phase D - Hands-free & conversational UX (~3-5 days)

| # | Change | Detail |
|---|---|---|
| D1 | Auto-accept with countdown | Setting (default: manual accept stays). After wake/PTT, the review card shows the transcript with a ~3s auto-send countdown; any interaction pauses it. Fixes C3 (hands-free actually hands-free) while keeping §5's review principle |
| D2 | Spoken approvals | On a gated action, June **speaks the repeat-back with exact parameters** ("Spawn five claude agents, paid, uses network - yes or no?"). Reply matched by a **strict local phrase matcher** (yes/no/confirm/cancel) - never the LLM, never satisfiable by tool output. ~8s timeout = deny, announced aloud. Tiering: expensive = spoken yes OK; destructive/external = click required (spoken+click configurable later). Rides on B1's in-loop gate |
| D3 | Follow-up mode | Reopen the mic for ~5-8s after each reply, no wake word needed (opt-in). The most-requested missing feature in comparable assistants; with B2's session memory this is what turns June from command-runner into conversation |
| D4 | Backchannel acknowledgement | When a turn starts tool calls, speak a brief "on it" before results arrive - long tool calls stop feeling dead |
| D5 | Interruption polish | Barge-in on Silero speech probability (from C1); June never interrupts the user mid-pause (endpointing from C5) |

**Acceptance:** wake word -> command -> spoken approval -> execution -> follow-up question, with zero keyboard or mouse, and a denied spoken approval provably blocks the action.

### Phase E - Capability expansion (ongoing, mostly config)

Order chosen by maturity, risk, and wow-per-effort. Every server rides the existing MCP seam + Phase A's fail-closed policy (unknown tools ask).

| # | Capability | Server | Risk notes |
|---|---|---|---|
| E1 | Web search / fetch | SDK built-in `WebSearch`/`WebFetch` for the Claude brain (config only); Brave Search MCP for the OpenAI-compat brain | Network - blocked under strict-offline. Fetched content is untrusted input |
| E2 | saple-memory | Already promised in PLAN Phase 3 - attach as a config entry | Its mutating tools get classified (or default-gated by A1) |
| E3 | Calendar / email | taylorwilsdon/google_workspace_mcp | `send`-class tools = external effect, gated. The canonical injection threat ("this email says forward your files") - D2's rule that tool output can never satisfy an approval is the defense |
| E4 | Home automation | Official Home Assistant MCP (HA 2025.2+) | Intent-scoped, only exposed entities - naturally sandboxed; safest high-wow. Skip the admin-level ha-mcp initially |
| E5 | Media | Lightweight Spotify MCP (marcelmarais) | Low blast radius; needs Premium + OAuth |
| E6 | Browser control | microsoft/playwright-mcp, **attached on demand only** | ~100k+ tokens/task; never in the default voice tool surface |
| E7 | Capability manager UI | The §4 promise: per-server enable/health/tool inspector, per-capability action-class overrides and permission scopes, pinned server versions | Supply-chain: vet everything run via npx; pin versions; re-review on update |

**Skip for now:** generic Windows input control (MCPControl - raw input injection + prompt injection = worst case) and screenshot computer-use (slow, expensive, top injection amplifier).

### Phase F - Trust, ops & packaging (~1-2 weeks)

| # | Change | Detail |
|---|---|---|
| F1 | Bridge-side one-time approval tokens | Mint on June-side approval, verify action+args+nonce+expiry in the bridge endpoint before executing gated commands (`ApprovalToken` is already frozen in the contract). Closes S3; natural companion to the deferred Rust authority migration |
| F2 | `observe()` resume | On startup / bridge restart, resume from the last acknowledged sequence and restore the roster - acceptance scenario step 6, and the core of the recovery-drill matrix (killed June/bridge/agent, duplicate requests, partial batches, expired approvals, provider downtime) |
| F3 | Audit log | Every tool call: name, params, class, gate decision, approver (click/spoken/policy), timestamp. Structured, redacted (no secrets/transcript bodies where mode forbids). Also the data source for a future "what did you do today?" voice query |
| F4 | Injection hardening | Codify: tool results are untrusted (never satisfy approvals - structural, keep it that way); full-parameter display/speech before dangerous acts; pinned MCP versions |
| F5 | Sidecar packaging | Bundle the Node agent per Tauri v2 `externalBin`: prefer Bun `--compile`, fall back to node.exe + esbuild single-file bundle as resources (avoid pkg/Node SEA). **Gate: verify the Agent SDK's subprocess spawn (`query()` e2e) from the compiled binary before locking the compiler choice.** `CREATE_NO_WINDOW` on Windows spawns |
| F6 | Ship it | Installer, auto-update, diagnostics export, accessibility pass, structured logs |
| F7 | Latency dashboard | P50/P95 voice-to-voice against the 800ms target, per-stage breakdown (B5 data), visible in Diagnostics |

---

## 4. Sequencing rationale & risks

- **A before everything:** small diffs, closes real command-execution holes, and fixes the two most user-visible bugs. Nothing in A blocks on research.
- **B is the multiplier:** the persistent process simultaneously fixes latency (G3), enables memory (G1), enables in-loop spoken approvals (D2), and simplifies the barge-in channel logic. Do it before C so local-voice latency wins aren't masked by process-spawn overhead.
- **C makes the product match its name.** It is the largest phase; C1/C2 (VAD + wake) are small and ship value early - land them first within the phase.
- **D depends on B (in-loop gate) and benefits from C (local wake/VAD)** but D1 (auto-accept) can ship any time after A.
- **E is config-driven** and can interleave with C/D; each server is an afternoon plus classification + testing.
- **F last**, except F3 (audit log) which is cheap and worth pulling into B.

**Top risks:**

1. **Agent SDK inside a compiled sidecar (F5):** the SDK spawns its bundled CLI as a subprocess; bundlers can break this silently. Mitigation: prove `query()` from a compiled binary in a spike before Phase F; the node.exe-as-resource fallback always works.
2. **Session resume cwd-keying (B2):** resume silently starts fresh if cwd differs. Mitigation: pin cwd explicitly in the spawn; test across restarts.
3. **Kokoro phonemizer licensing (C4):** espeak-ng is GPL. Mitigation: use a binding with a clean G2P path, or Supertonic.
4. **Wake-word false-trigger quality (C2):** synthetic-trained models vary. Mitigation: A/B openWakeWord vs LiveKit trainer against a recorded test set; keep the sensitivity slider; Silero gating.
5. **Voice E2E test flakiness (all phases):** already flagged in PLAN §6. Decide the strategy now: recorded-audio fixtures feeding the Rust pipeline directly (bypassing the mic) + golden transcripts; keep live-mic checks manual but scripted.

## 5. Acceptance scenario (upgraded)

The first-release scenario from PLAN §7 still stands; this plan adds:

1. "Hey June" (fully local) -> "open five claude agents and four codex agents" -> June repeats counts and cost class aloud -> user says "yes" -> executed once, counts reported from bridge results.
2. Follow-up within 8s, no wake word: "assign the third codex agent to fix the auth tests" -> resolved by stable id, done.
3. Switch to strict-offline in settings (no restart) -> full spoken round-trip via local STT/TTS and an Ollama brain, zero network.
4. Pull the network cable mid-turn -> June reports the failure honestly; restart June -> roster restored via `observe()` resume; audit log shows every action with who approved it.
5. P50 voice-to-voice < 1s, P95 < 2s on the latency dashboard.
