# Improvement round 6: ten-dimension deep scan, merged plan

Ten parallel deep-dives (voice pipeline, agent loop, missions/loops, frontend, Rust backend,
tools/integrations, reliability, security, performance, product vision) over the post
improvement-5 codebase. ~85 raw findings deduped to the plan below. Items several dimensions
independently converged on (marked "x2"/"x3") are the highest-confidence work.

Legend: P0 = fix first, P3 = later. S/M/L = effort.

---

## Phase 1 - Stop the bleeding (correctness and safety) - DONE

Small, high-severity fixes. Everything here is S unless noted.

**Status: all 12 items implemented and verified** (typecheck, eslint, 214 vitest
tests, 32 cargo tests, clippy `-D warnings` all green). New coverage: policy.test.ts
pins the automation-prompt approval card (1.2); scheduler.rs pins the persisted-state
round-trip + legacy migration (1.9).

1.1 **Fix CI: workflow targets `main`, repo lives on `master`** | P0 - DONE
    CI has never run once. Change the `branches:` filters in `.github/workflows/ci.yml`
    to `[master]`, add `workflow_dispatch`, then fix whatever red surfaces.

1.2 **Show the real prompt on `add_schedule`/`add_watch` approval cards** | P0 - DONE
    The one gated action whose payload later runs unattended hides that payload from the
    approver - an injected instruction can be committed to recurring unattended execution
    under an innocent label. Append the capped `prompt` param in `summarize()`
    (`agent/policy.ts`) and pin it in `policy.test.ts`.

1.3 **Neuter `JUNE_APPROVE=allow` outside tests** | P1 - DONE
    The env var silently auto-approves every gated action. Strip it from the resident's env
    in `spawn_serve()` (`src-tauri/src/agent_runner.rs`) unless a dev/test build.

1.4 **Align SDK session persistence with local-voice privacy mode** | P1 - DONE
    `persistSession = !(mode === "strict-offline")` in `agent/serve.ts:251` means
    local-voice mode still writes full transcripts to disk while the ledger redacts.
    Change to `persistSession = mode === "standard"`.

1.5 **Claude brain: mid-turn "New conversation" crash** | P1 - DONE
    `run()` re-reads `this.#query!` each iteration; a mid-turn reset nulls it and throws a
    raw TypeError. Capture the reference once (same as the B4.4 fix in openai-brain).
    `agent/claude-brain.ts`.

1.6 **Claude brain: no tool-loop bound = unbounded spend** | P1 - DONE
    OpenAI path caps at 12 steps; Claude path has no `maxTurns` and every tool event resets
    the watchdog. Pass `maxTurns` in `#ensureQuery` and map `error_max_turns` to a short
    spoken message. `agent/claude-brain.ts`.

1.7 **One failing MCP server blocks all tools and leaks stdio clients** | P1 | S/M - DONE
    `#ensureConnected` connects sequentially; a throw fails the turn and orphans the
    already-connected clients on every retry. Try/catch per server, skip failures, close on
    total failure. `agent/openai-brain.ts:281-305`.

1.8 **Speechless-clip guard on the command path** | P1 - DONE
    Whisper hallucinates "Okay." on silence and `handsFree.autoAccept` auto-sends it.
    `heardSpeech()` already exists - gate `beginTranscribe` on it and skip the cloud STT
    call entirely. `src/voice/VoicePanel.tsx`, `src/lib/voice-capture.ts`.

1.9 **Persist watch-loop state; auto-retire a finished watch** | P1 - DONE
    `watch_fired`/`watch_iters`/`watch_done` are in-memory (`scheduler.rs:455`), so a DONE
    watch re-arms, re-fires and re-notifies on every app restart, forever. Persist in
    `june-scheduler.json` (the `save_fired` machinery is right there); on DONE flip the
    watch's `enabled` to false in settings.

1.10 **Kill the whole serve.ts process tree, not just cmd.exe** | P1 | M - DONE
    `child.kill()` on Windows kills only the `cmd /C` wrapper - every respawn and every
    tray Quit leaks a live node/tsx tree with open MCP connections. Graceful-first (close
    stdin, wait with deadline), escalate to `taskkill /T /F`; add a `RunEvent::ExitRequested`
    shutdown. `src-tauri/src/agent_runner.rs`, `src-tauri/src/lib.rs`.

1.11 **Stop holding the resident mutex across spawn + backoff sleep** | P1 - DONE
    An approval click during a respawn blocks on the mutex for up to 8s and freezes the UI.
    Sleep before acquiring, or add a "spawning" flag so `write_request` fails fast.
    `src-tauri/src/agent_runner.rs::ensure_resident`.

1.12 **Remove the tray-icon startup `unwrap()`** | P3 - DONE
    `default_window_icon().unwrap()` panics the whole app if the bundle icon is missing.
    Build the tray without an icon instead. `src-tauri/src/lib.rs`.

---

## Phase 2 - See what is happening (observability and trust)

2.1 **File logger for release builds** (x2: rust + reliability) | P1 | M - DONE
    Windowed release builds discard every `eprintln!` failure path (audit, runs, mission,
    scheduler) - failures are undiagnosable on a user machine. Rotating file log at
    `<app_data_dir>/june.log`, route the ~8 sites through it, and pipe the resident's
    stderr into it so serve.ts crash output survives.
    New `src-tauri/src/logf.rs`: `log(app, line)` appends a timestamped line to
    `june.log` (rotated one generation at 2MB), mirrors to stderr in debug. Routed the
    audit/runs/mission/scheduler write-failure sites through it; `spawn_serve` now pipes
    the resident's stderr (was `Stdio::inherit`) into `june.log` via a `[serve]` reader
    thread. `log_message` command backs 2.2.

2.2 **Renderer ErrorBoundary + global error hooks** | P1 - DONE
    A render throw blanks the always-on-top widget with no trace ("June died"). One
    top-level ErrorBoundary around `<Face />` plus `error`/`unhandledrejection` handlers
    forwarding into 2.1. `src/main.tsx`.
    New `src/app/ErrorBoundary.tsx` (catches render throws, logs the stack, shows a
    recoverable "June hit a display error" + Reload card) and `src/lib/errorlog.ts`
    (`reportError` -> `log_message`, `installGlobalErrorHooks` for
    error/unhandledrejection). Wired into `main.tsx`; `.error-fallback` styling added.

2.3 **Missions write to the run ledger** (x2: missions + frontend) | P1 | M - DONE
    Missions bypass `append_run` entirely and "Clear mission" destroys the only record a
    mission ever existed, including failure notes. Append per-mission (or per-task) ledger
    records with verify verdicts from `run_board`. `src-tauri/src/missions.rs`.
    `append_run` is now `pub(crate)`; `run_board` appends one ledger record per task
    (`source: "mission: <outcome>"`, prompt = task title, reply = the reply on success or
    the verify note on failure, `isError = !ok`), keyed by the task's `active_turn`. A
    cleared mission now leaves durable history in the Runs tab.

2.4 **Live Runs tab** (x2: missions + frontend) | P1 | S - DONE
    The trust surface is manual-refresh only, never shows the run's prompt, and has no
    unseen indicator. Emit `runs://updated` from `append_run`, listen in `RunsPanel`,
    render the prompt expandable, use relative times, badge the tab. Add a per-schedule
    "Run now" command so users can test a 9am briefing without editing the time.
    `src/app/RunsPanel.tsx`, `src/app/AppWindow.tsx`, `src-tauri/src/agent_runner.rs`,
    `src-tauri/src/scheduler.rs`.
    `append_run` now emits `runs://updated`; `RunsPanel` auto-refreshes on it (silent,
    no loading flash), shows relative times (absolute on hover), and an expandable
    `<details>` prompt. `AppWindow` badges the Runs tab when a run lands off-tab. New
    `scheduler::run_schedule_now(id)` command fires a saved schedule as a one-off
    unattended run on a background thread (refuses while busy, leaves the daily
    `fired` bookkeeping untouched); a "Run now" button per schedule card in
    `SettingsPanel` drives it.

2.5 **Spoken-friendly error messages** | P2 - DONE
    Raw API JSON bodies are read aloud by TTS ("the model API returned 401: {...}").
    Map 401/403/429/404 to short sentences, keep the raw body in the log. Also add the
    missing `"error"` arm in `spawn_reader` so serve.ts startup failures reach the UI
    instead of the generic "stopped unexpectedly". `agent/openai-brain.ts`,
    `agent/claude-brain.ts`, `src-tauri/src/agent_runner.rs`.
    New `agent/errors.ts`: `friendlyApiError(status)` maps 401/403/429/404/5xx to one
    short spoken sentence, `statusFromMessage` pulls a status out of an SDK error
    string. openai-brain's `#complete` now logs the raw body (piped into june.log)
    and throws the mapped sentence; claude-brain wraps its turn loop in a catch that
    logs the raw error and speaks the mapped line. `spawn_reader` gained an `"error"`
    arm that logs the real startup failure and delivers it to awaiting turns instead
    of the generic "stopped unexpectedly". Pinned by `agent/errors.test.ts`.

2.6 **Token/cost accounting** | P2 | M - DONE
    Both brains drop `usage`/`total_cost_usd`. Extend `TurnResult`, ride it on the `final`
    event into `append_run`, show a cumulative session readout in Diagnostics next to the
    latency percentiles. `agent/brain.ts`, both brains, `agent/serve.ts`,
    `src-tauri/src/agent_runner.rs`.
    New `TokenUsage` on `TurnResult`. The OpenAI brain sums `prompt_tokens`/
    `completion_tokens` across every completion in the tool loop (no cost - the API
    doesn't price it); the Claude brain reads the SDK result's `usage` (folding cache
    tokens into inputTokens) + `total_cost_usd`. serve.ts rides `usage` on the `final`
    event. The reader accumulates a session-wide `UsageTotals` (input/output/cost/
    turns) and stamps per-run usage into the ledger via a new `append_run` arg. New
    `usage_total` command + `usageTotal()` client + a "Session usage" readout in the
    Diagnostics panel. Mission tasks count toward the session total but carry no
    per-ledger usage (dispatch returns only text) - noted with a ponytail comment.

2.7 **Surface silent VAD/wake degradation** | P2 - DONE
    Silero/openWakeWord load failures are swallowed - broken assets permanently downgrade
    endpointing/wake with no signal. Record which path is live (silero/rms,
    local-wake/cloud-burst) plus the load error; one line in Diagnostics.
    `src/lib/voice-capture.ts`, `src/lib/wake.ts`, `src/lib/diagnostics.ts`.
    New `src/lib/voice-health.ts` (`reportVoiceHealth`/`voiceHealth`) backed by Rust
    `record_voice_health`/`voice_health` + a `voice_health` session map (the widget
    writes, the app's Diagnostics reads - separate webviews, same pattern as latency).
    The three `.catch(() => null)` fallback sites - barge monitor + endpointing in
    voice-capture.ts, local-wake in wake.ts - now capture the load error and report
    `{path, error}` (silero|rms, local|cloud-burst|unavailable). A "Voice stack"
    readout in Diagnostics shows each subsystem's live path (ok for local-first,
    bad + the load error for a fallback).

2.8 **Distinguish keychain failure from "no key set"** | P2 - DONE
    `test_brain` treats a broken/locked keychain as an empty key and reports success.
    Return `ok: false` with the keychain error; add the module's first tests.
    `src-tauri/src/diagnostics.rs`.
    New `keychain::get_api_key_opt` returns `Ok(None)` for a genuinely-unset key vs
    `Err` for a real read failure (the old `get_api_key_inner().unwrap_or_default()`
    collapsed both to `""`). `test_brain` now fails the probe with the keychain error
    instead of falling through to "no key - use local sign-in". Extracted two pure
    helpers (`key_service_for`, `resolve_key`) and added diagnostics.rs's first tests,
    pinning the "broken keychain is not an empty key" rule and the provider->service
    mapping.

2.9 **Test the untested trust paths** | P1-P2 | M - DONE
    (a) serve.ts protocol seam: turn framing, cancel, approval round-trip, malformed input
    (every turn crosses it, zero tests). (b) Run-ledger redaction + rotation: the
    "local-voice prompts never land on disk" rule is uncovered - extract the record
    builder as a pure function and test both privacy modes. `agent/serve.ts`,
    `src-tauri/src/agent_runner.rs`.
    (a) Extracted the trust-critical seam from serve.ts into new `agent/protocol.ts`
    (`parseRequest`, `withRecalledLessons`, `parseMcpServers`, and an `ApprovalHub`
    class owning the gate / approval round-trip / cancel / unattended-block logic with
    `emit` + timeout injected). serve.ts is now a thin wrapper constructing an
    `ApprovalHub` over stdout `emit`. `agent/protocol.test.ts` (13 tests) pins malformed
    input, turn framing/fencing, the approval round-trip (click allow/deny, cancel
    self-deny, timeout expiry), and the unattended leash (gated blocked before any
    override, networked observe blocked). (b) Extracted `build_run_record` as a pure
    function; 4 new agent_runner tests pin on-device redaction (content never reaches
    disk), standard-mode retention + capping, and usage riding verbatim under both
    modes. Full suite: 230 vitest + 40 cargo tests green.

---

## Phase 3 - Voice quality and latency

3.1 **One shared `reqwest::Client`** | P1 | S - DONE
    STT, TTS and diagnostics each build a fresh client (new pool + TLS handshake) per
    call - on both voice legs of every turn. `static OnceLock<Client>` with per-request
    timeouts. `src-tauri/src/stt.rs`, `tts.rs`, `diagnostics.rs`.
    New `src-tauri/src/http.rs`: `client()` returns a process-wide `OnceLock<Client>`
    built once with a 5s connect timeout; the four call sites (stt, tts, and both
    diagnostics probes) now reuse it and set their own total timeout per request via
    `RequestBuilder::timeout` (STT 15s, TTS 30s, probes 2s). Dropped the per-call
    `Client::builder()` and its build-error arms. All 40 cargo tests + clippy green.

3.2 **Move local STT/TTS inference off the webview main thread** | P1 | M - DONE
    `numThreads: 1`, no worker proxy - Moonshine and every Kokoro sentence freeze the
    widget UI and stall barge-in Silero inference. Set ORT `proxy: true` in
    `src/lib/xformers.ts` (or wrap in a Web Worker); verify barge-in latency before/after.
    Set `wasm.proxy = true` in `configureXformers()` so the shared transformers.js ORT
    backend runs in a worker instead of the widget's main thread (orthogonal to the
    `numThreads: 1` no-SharedArrayBuffer constraint - proxy only relocates the
    single-threaded backend off the UI thread). Typecheck + eslint green. Barge-in
    latency before/after still wants a device run - the win is not measurable in CI.

3.3 **Persistent audio front-end: shared mic stream + warm VAD + pre-roll ring buffer** | P1 | L
    Every phase transition reopens `getUserMedia` and a fresh `MicVAD` (100-400ms each on
    Windows), re-warms the wake buffer, clips first words after wake, and caused the
    documented follow-up clip and `openingMic` race guards. Own the stream once in a
    `mic.ts` manager with a rolling ~1s 16kHz ring buffer; capture/wake/barge/follow-up
    attach listeners instead of reopening; prepend the ring buffer to wake-started
    captures. `src/lib/voice-capture.ts`, `wake.ts`, `vad.ts`, `src/voice/VoicePanel.tsx`.
    Foundation shipped (ref-counted stream ownership), pre-roll prepend deferred.
    New `src/lib/mic.ts`: `MicManager` ref-counts one shared `MediaStream` - it opens
    on the first consumer and closes a short linger (800ms) after the last release, so
    a PTT-only user never has a hot mic at rest yet a wake -> capture handoff never
    re-opens the device (the linger bridges the overlap where wake releases as capture
    acquires). The three `getUserMedia` sites (`startCapture`, `startBargeMonitor`,
    `startWakeListener`, incl. the local-wake, cloud-burst and unavailable teardowns)
    now `acquireMic()`/`lease.release()` instead of opening and stopping their own
    stream; the dead `audioConstraints` helper is gone (the manager owns constraints,
    which are the getUserMedia defaults anyway, so one shared stream matches prior
    behaviour). A `PreRollRing` (16kHz, ~1s, wrap-around) is fed by the barge-monitor
    and capture Silero `onFrame`s so it stays warm across a handoff. `mic.test.ts`
    pins the ring's retention and the manager's dedup/handoff/linger/idempotent-release/
    device-swap/unplug-reopen paths (11 tests; full suite 240 vitest green).
    ponytail: the ring is populated but not yet PREPENDED to a wake/follow-up clip -
    that needs replacing `MediaRecorder`(webm) with PCM+WAV capture, which only pays off
    once first-word clipping and barge-in latency can be measured on a real Windows mic
    (not observable in CI). Warm-`MicVAD` reuse (vs. one `MicVAD` per consumer) is the
    other deferred half. Do both in a device session.

3.4 **Barge-in while thinking** | P2 | S - DONE
    The barge monitor only arms on `speaking`; during long tool calls speech does nothing.
    Extend the condition to `thinking || speaking` - the callback already handles both.
    `src/voice/VoicePanel.tsx`.
    The barge-monitor effect's guard is now
    `(phase.s !== "speaking" && phase.s !== "thinking") || approval`, so the
    echo-cancelled monitor mic opens during long tool calls too. `bargeIn` already
    cancels the turn and starts a new capture regardless of phase, and the effect
    deps (`phase.s`) already re-run on the thinking->speaking transition, so no
    monitor churn. Approval-pending still owns the mic (spoken-approval flow).

3.5 **Cache canned TTS phrases** | P2 | S - DONE
    "On it." / "Okay, cancelled." are re-synthesized (cloud round-trip or Kokoro run) on
    every occurrence. Small keyed memo in `synthesize()`. `src/lib/tts.ts`.
    New exported `CANNED_PHRASES` constant (onIt / cancelled / noYesCancel /
    micFailCancel) is the single source of truth for the fixed backchannel/approval
    lines; `VoicePanel` now references it instead of string literals so the cache key
    can't drift from what's spoken. `synthesize` memoizes ONLY these phrases, keyed by
    `provider|model|voice|text` (a voice/provider change re-synthesizes); a failed
    synthesis is evicted so it isn't cached. Arbitrary reply text bypasses the cache
    (`synthesizeRaw`), so the memo can't grow unbounded. `tts.test.ts` pins
    cache-hit-once, non-canned-always-synthesizes, and voice-change-re-synthesizes.

3.6 **Claude streaming: real deltas, not whole blocks** | P2 | M - DONE
    `onText` fires once per finished block, inflating time-to-first-audio against the
    800ms target. Set `includePartialMessages: true` and emit `stream_event` deltas,
    keeping the block path as dedupe fallback. `agent/claude-brain.ts`.
    `includePartialMessages: true` in the query options; the run loop now handles
    `stream_event` `content_block_delta` (`text_delta`) and calls `onText` with each
    delta the moment it arrives, so the SentenceBuffer can flush the first sentence
    to TTS long before the block completes. A per-message `streamedText` flag skips
    the subsequent full `assistant` text block when its deltas already streamed (no
    double-speak), and resets per assistant message so a block that DIDN'T stream
    still falls back to speaking the whole text. `claude-brain.test.ts` mocks the SDK
    `query` to pin deltas-only-not-doubled, whole-block-fallback, and the per-message
    reset. The 800ms time-to-first-audio win itself wants a device run.

3.7 **Retry transient completion errors** | P2 | S - DONE
    One 429/network blip kills the spoken turn. Retry 429/5xx once or twice in
    `#complete`, honor `Retry-After`, bail on abort and 4xx auth. `agent/openai-brain.ts`.
    Extracted the POST into `#fetchWithRetry` (initial try + 2 retries): a network
    throw and a 429/5xx retry; a 4xx and an abort (barge-in) are terminal and
    propagate unchanged so `run()` rolls the turn back / speaks the mapped sentence.
    `#backoff` honors a numeric `Retry-After` (capped 10s) on a 429, else exponential
    (0.5s, 1s), and rejects at once if the turn aborts mid-wait so a barge-in never
    stalls on a dead request. The raw body still lands in june.log; only the short
    mapped sentence is thrown. `openai-brain.test.ts` pins retry-429-then-succeed,
    retry-dropped-connection-then-succeed, and 4xx-fails-at-once. (HTTP-date
    Retry-After falls back to exponential - noted with a ponytail comment.)

3.8 **Give the model a clock** | P2 | S - DONE
    Nothing injects the current date/time, yet June creates "daily at 9am" schedules and
    answers "what day is it" blind. One line per turn in `runTurn`, outside the fenced
    untrusted blocks. `agent/serve.ts`.
    `runTurn` now prepends `Current date and time: ${new Date().toString()}` (includes
    the local timezone offset + name, so "daily at 9am" resolves and "what day is it"
    answers) to the composed prompt, BEFORE the fenced untrusted/lessons blocks - a
    poisoned trigger payload can't spoof the clock. Computed per turn so a long-lived
    resident never reads a stale time.

3.9 **Audio output device picker** | P2 | S - DONE
    Mic picker shipped (6.5) but TTS speaks on system default - headset users get AEC
    fighting a different device. `outputDeviceId` setting + `setSinkId()` in
    `SpeechQueue.#play`. `src/lib/tts.ts`, `settings.ts`, `SettingsPanel.tsx`.
    New `outputDeviceId` setting ("" = system default, round-tripped through
    `parseSettings`). `tts.ts` gained module-level `setOutputDevice`/`outputSinkId`
    (mirroring the existing volume knob); `SpeechQueue.#play` calls
    `el.setSinkId(outputSinkId)` before playback, guarded on API presence and
    failing back to the default on an unsupported engine or a stale device id.
    `VoicePanel.refreshSettings` pushes the setting live on `settings://changed`.
    The `MicPicker` was generalized to a `DevicePicker` (kind = audioinput |
    audiooutput); the TtsCard gained a "Speaker" row and its Test button now routes
    the sample through the chosen sink (`playBytes` takes a `sinkId`) so the test
    exercises the real device. settings.test pins the new default.

3.10 **Train and ship the real "hey june" wake model** | P2 | M - BLOCKED (needs the trained artifact)
    The local wake phrase is literally "hey jarvis" (openWakeWord stand-in). Train
    `hey_june.onnx` per the openWakeWord recipe, pin its SHA-256 in
    `scripts/fetch-models.mjs`, drop into `createWakeRunners`.
    The only deliverable is the trained model file itself, and the code seam already
    accepts it with zero code change (confirmed: `wake.ts` + `createWakeRunners` load
    the classifier by path; `fetch-models.mjs` downloads+checksums it beside the
    shared melspec/embedding models). Producing `hey_june.onnx` means running the
    openWakeWord training pipeline offline (synthetic "hey june" TTS utterances +
    negatives, ~hours on a GPU) - it cannot be done in a coding session, and there is
    no published "hey june" model to fetch. To finish: run the recipe, host the
    `.onnx`, add a `{ url, dest: "wake/hey_june_v0.1.onnx", sha256 }` entry to
    `downloads` in `fetch-models.mjs`, and point `createWakeRunners` at it. No other
    code changes required.

3.11 **Abort in-flight synthesis on barge-in** | P3 | S - DONE
    `SpeechQueue.stop()` drops the queue but running synth promises keep spending cloud
    tokens and burning the main thread right when the next capture needs it. Thread an
    aborted flag + cancel down to Rust `synthesize`. `src/lib/tts.ts`, `local-tts.ts`,
    `src-tauri/src/tts.rs`.
    Each `SpeechQueue` owns a cancel token (`newCancelToken`) + an `AbortController`.
    Rust `tts.rs` gained a per-token cancellation registry (refcounted `Notify` per
    token, reaped when the last synth releases) and a `cancel_synthesis(token)`
    command; the `synthesize` command now takes a `cancel_token` and, when set, races
    the request against `notify.notified()` in a `biased tokio::select!` so a barge-in
    drops the network read mid-flight instead of finishing an mp3 no one hears. Scoped
    to the token (not a global signal) so stopping the "On it" backchannel - which
    happens the instant the real reply starts speaking - never cancels the reply's own
    in-flight sentences. `stop()` calls `cancel_synthesis` + aborts the signal; the
    local Kokoro path skips a not-yet-started run on the signal (Kokoro can't be
    interrupted mid-run). tokio declared directly in Cargo.toml (already in the tree
    via tauri - no new build cost) for `select!`/`Notify`. cargo test pins the
    registry refcount reaping; 240 vitest + 41 cargo green, clippy `-D warnings` clean.

3.12 **Stream cloud TTS playback** | P3 | M - DEFERRED (gate unmet, no evidence to justify)
    First audio waits for the complete first-sentence mp3. Chunk the response body over a
    Tauri channel into a MediaSource buffer. Only do it if Diagnostics shows p50 tts
    meaningfully above ~300ms. `src-tauri/src/tts.rs`, `src/lib/tts.ts`.
    Held per its own precondition. Two facts make building it now premature: (1) there
    is no isolated TTS-synth p50 metric to evaluate the gate - `latency.ts` only records
    `firstAudio - firstToken`, which conflates brain streaming with synthesis, so we
    cannot show TTS p50 > ~300ms; (2) it is greenfield machinery (Tauri `ipc::Channel`
    streaming + a MediaSource/SourceBuffer append queue for `audio/mpeg`, plus a
    barge-in interaction with the new 3.11 cancel), and sentence-streaming already puts
    first-audio at one SHORT first sentence's latency, where MSE setup overhead can
    exceed just fetching the whole small clip. To do it well first add a per-synth TTS
    duration metric to Diagnostics; if a device shows p50 meaningfully above ~300ms,
    then stream: `synthesize_stream(app, text, ..., channel)` in Rust forwarding
    `resp.chunk()` (honoring the 3.11 cancel registry), fed into a SourceBuffer in
    `SpeechQueue`.

---

## Phase 4 - New capabilities (what June can do)

4.1 **One-shot reminders and timers: `kind: "once"`** (x2: product + tools) | P0 | S - DONE
    "Remind me in 20 minutes" is daily-driver table stakes and only a schedule kind away.
    Add `once` with an absolute fire time to `Schedule`, teach `is_due` to fire-then-
    disable, extend the automation server's zod schema and `summarize()`. On fire, speak
    via TTS + OS notification - no agent turn needed for a plain reminder.
    `src/lib/schedules.ts`, `src-tauri/src/scheduler.rs`, `mcp/automation/server.ts`,
    `agent/policy.ts`.
    New `once` ScheduleKind with an absolute local `at` ("YYYY-MM-DDTHH:MM", no tz,
    read as local to match the Rust `NaiveDateTime`). `coerceSchedules` drops a once
    entry whose `at` is malformed OR a non-existent date (Feb 30) via `isValidAt`, so a
    reminder that would silently never fire is rejected up front. The scheduler's
    `once_due` fires exactly once at/after `at` within the 30-min catch-up window and
    never again; on fire the schedule loop takes a dedicated path - NO agent turn -
    calling `deliver_reminder` (OS notification + a `reminder://fired` event the voice
    widget speaks via TTS, mirroring the "On it" ack queue), records it fired, and
    retires it with the new `settings::disable_schedule` (mirrors `disable_watch`) so it
    neither re-fires this session nor re-arms on restart. The automation `add_schedule`
    tool gained `once` in its kind enum + an `at` param and a reminder-phrased success
    line; `policy.summarize` renders a once card as `Remind "x" once at <at>: "<prompt>"`
    (still gated + prompt-visible, 1.2). A once schedule shows read-only in the Settings
    automation list (voice-created, self-retiring) rather than as editable daily controls.
    Pinned: schedules.test (valid/malformed/Feb-30/no-at coercion), scheduler
    once_due (window/late/before/already-fired/malformed), store.test
    (validate + summarize), policy.test (summarize once). Full suite: 251 vitest +
    Rust scheduler tests green, clippy `-D warnings` + eslint clean.

4.2 **Voice management verbs: remove / enable / disable automations** (x2) | P1 | S - DONE
    The automation server can create but never manage - "stop the build watch" is
    impossible by voice. Add `set_automation_enabled` + `remove_automation` (match by id
    or label), classify `reversible`; cover triggers too. `mcp/automation/server.ts`,
    `store.ts`, `agent/policy.ts`.
    Two new pure store helpers - `setAutomationEnabled` and `removeAutomation` - scan
    all three managed lists (schedules, watches, triggers) via one shared `findMatch`
    that matches an exact id OR a case-insensitive label ("stop the build watch" ->
    "Build watch"). Both are pure: they return a new bag touching ONLY the matched
    entry (every other entry and settings key preserved verbatim, including a once
    reminder's `at`) plus a `ManageResult` naming what matched, or the bag unchanged +
    null when nothing matches (the tool then speaks "I couldn't find..."). The two new
    MCP tools read-modify-write through the same serialized atomic path as add_*.
    Classified `reversible` in policy (auto-runs with the user present - frictionless
    voice management), which is deliberately NOT `observe`, so `unattendedBlockReason`
    still blocks them on an unattended run: an injected trigger prompt can't silently
    disable June's own safety watches. `summarize` renders both for the audit/card
    ("Disable automation Build watch", "Remove automation Morning briefing"). Pinned:
    store.test (disable-by-label/enable-by-id/remove-by-label/no-match-unchanged),
    policy.test (reversible class + unattended-blocked + summarize). Full suite: 256
    vitest green, typecheck + eslint clean.

4.3 **`mcp/system` observe pack** | P1 | M - DONE
    Unattended watch loops may only call local observe tools, which today means the files
    root or the bridge roster - "watch until the build is green" barely has eyes. New
    built-in server: `list_processes`, `process_running(name)`, `system_stats`. Register
    in `BUILTIN_SERVERS`, `RESERVED_IDS`, `ACTION_CLASS` as observe.
    New `mcp/system/`, `agent/policy.ts`, `src/lib/mcp-servers.ts`, `agent/core.ts`.
    New built-in `mcp/system/server.ts` with three LOCAL read-only tools; all three
    classified `observe` in `ACTION_CLASS`, so they auto-run AND pass
    `unattendedBlockReason` (local, non-networked, non-memory-write) - a watch loop can
    finally ask "is the build process still alive". `system` is a built-in id in both
    `BUILTIN_SERVERS` (policy) and `RESERVED_IDS` (mcp-servers), so a user-added server
    can't shadow it with an ungated same-named tool. Wired always-on in `core.ts`
    (`systemMcpServer()`, no env/root - it needs no config), so it stays available in
    every privacy mode like the files reads. All the CSV/matching/rounding logic lives
    in a pure `parse.ts` (`parseTasklistCsv` honors the comma-in-quoted-memory column,
    `countProcesses` matches ".exe"-insensitive + case-insensitive, `summarizeStats`
    rounds GiB/percent and omits the always-0 Windows load average). Process tools
    shell `tasklist /FO CSV /NH` (Windows-first; other OSes get a clear error, not a
    lying empty list); `system_stats` reads node's `os` module. Pinned: parse.test
    (CSV quoting, N/A memory, non-numeric-PID skip, match count, stats rounding both
    platforms). Full suite green, typecheck (+ new `mcp/system/tsconfig.json` in the
    typecheck script) + eslint clean.

4.4 **Foreground-context awareness (metadata, not pixels)** | P1 | S/M - DONE
    90% of "what am I looking at" is answerable from window metadata; no display capture
    needed. Observe-class `get_active_context`: Win32 `GetForegroundWindow` title +
    process name (+ browser tab URL via UI Automation later). Local-only, works under
    strict offline, audit-logged. New `src-tauri/src/context.rs`, `agent/policy.ts`.
    Landed in the `mcp/system` server, NOT a Rust `context.rs`: the agent runs as a
    node subprocess with no IPC channel back to the Tauri host, so a Rust command it
    can't invoke would be dead code. `get_active_context` reads the foreground window's
    OWN metadata via Win32 (`GetForegroundWindow` + `GetWindowText` +
    `GetWindowThreadProcessId` -> `Get-Process`) through PowerShell, run via
    `-EncodedCommand` (UTF-16LE base64) so the interop script's quotes/newlines never
    fight the shell, with `$ProgressPreference='SilentlyContinue'` so Add-Type's
    progress can't pollute stdout. Verified E2E: correctly returned the live foreground
    window (title + process). It is metadata-only (the description is explicit: no
    screen capture), classified `observe` in `ACTION_CLASS` (auto-runs, unattended-safe,
    local). Pure `parseActiveContext` degrades a blank/garbled/no-foreground payload to
    an empty context ({title:"", process:null, pid:null}) rather than throwing, and
    nulls a 0/absent pid. Windows-only (clear error elsewhere, not a lying empty
    context). Pinned: parse.test (well-formed / blank / garbled / untitled-no-process).
    Full suite green, typecheck + eslint clean.

4.5 **Quick-capture voice inbox** | P1 | S - DONE
    A sub-second "jot this down" path: second hotkey mode, speak -> local STT -> append a
    timestamped line to `june-inbox.md` (same contained-path pattern as memory), chime
    confirm, no brain in the loop. Optional "capture as task" via saple-memory
    `create_task`. `src-tauri/src/dictation.rs`, `src/lib/hotkey.ts`, `SettingsPanel.tsx`.
    A genuinely SECOND global hotkey (`captureHotkey`, default `ctrl+shift+j` for
    "jot"), not a mode toggle - hold it, speak, done, no toggling. Rust's one
    global-shortcut handler now dispatches by which chord fired (the fired `Shortcut`
    is compared against the two parsed chords held in a shared `Chords` mutex), routing
    to `ptt://*` or `capture://*`. `apply_hotkeys` re-registers BOTH live on
    settings://changed; PTT still never dies (default fallback), quick capture is
    optional - off when `captureHotkey` is empty, and REFUSED when it collides with the
    effective PTT chord (PTT wins, `capture://status` says why) so push-to-talk can
    never be shadowed. New `append_inbox` Tauri command appends `- [YYYY-MM-DD HH:MM]
    <line>` to `<app_data_dir>/june-inbox.md` (host-owned contained path like
    june-memory.md, created on first jot, local time to match the user's day); a blank
    clip is a no-op success like inject_text. The widget adds a third capture mode
    ("capture") beside command/dictation: `capture://down` tags it and starts a capture
    directly (never through the command-only `activate`, independent of dictation
    mode), and `beginTranscribe` routes it - clean the transcript, `appendInbox`, a
    short WebAudio chime, then a "Jotted to your inbox" confirm that self-expires. Both
    dictation and capture now share a `brainless` flag so a speechless clip stands down
    quietly instead of erroring. Settings gains a "Quick capture" card mirroring the PTT
    one (chord capture, live verify via `capture://down`, `capture://status` errors,
    Backspace turns it off). Skipped: "capture as task" via saple-memory create_task -
    the inbox file is the whole win; add when a user actually wants a jot promoted to a
    task. Also fixed a pre-existing `tsc` failure in automation/store.test.ts (reading
    `.enabled` off the loosely-typed SettingsBag) via a typed `lists()` view. Full
    suite 269 vitest green, typecheck + eslint + `cargo clippy -D warnings` clean.

4.6 **`open_path` / app launcher in `mcp/system`** | P2 | S - DONE
    Standalone June (no saple-bridge) cannot open a URL, file or app at all. `cmd /c start`
    node-side, classify `reversible`, validate the target is a plain path/URL before
    shelling out. `mcp/system/server.ts`, `agent/policy.ts`.
    `open_path(target)` added to the system server, classified `reversible` in
    `ACTION_CLASS` (same class as open_browser: auto-runs with the user present, still
    blocked UNATTENDED so an injected trigger can't launch apps or open exfiltration
    URLs). DEVIATION from the plan's `cmd /c start`: that routes the target through
    cmd's parser, where a URL's `&` is a live command-injection vector (`start ""
    "https://x?a=1&calc"` chains `calc`). Instead the target is handed to `explorer.exe`
    via a spawned ARGS ARRAY (no shell), which opens files/folders/URLs in the default
    handler with the argument passed by CreateProcess - injection-proof by construction,
    so a URL's `&` or a path's spaces are inert. Detached + unref'd (June never waits on
    the opened app; explorer's exit code is unreliable). Pure `validateOpenTarget`
    gates the input as the security core: accepts http(s) URLs and filesystem paths
    (drive/relative/UNC), REJECTS control characters and - critically - any `scheme:`
    that isn't http(s) or a `C:`-style drive letter, blocking `javascript:`/`file:`/a
    registered app-launcher scheme that could run code or launch an arbitrary app. A
    path is existence-checked up front for a clean error instead of a flashing OS
    window. Pinned: parse.test (URL-with-query, drive/relative/UNC paths, rejected
    custom schemes, empty/control-char). Full suite 273 vitest green, typecheck +
    eslint + clippy clean.

4.7 **Clipboard capability** (x2) | P2 | S - DONE
    "What's on my clipboard?" via `Get-Clipboard`/`Set-Clipboard` in `mcp/system` - zero
    new deps. Read is observe-class but hard-blocked for unattended runs (clipboards hold
    passwords); write is reversible. `mcp/system/server.ts`, `agent/policy.ts`.
    `read_clipboard` (`Get-Clipboard -Raw`) and `write_clipboard` (`Set-Clipboard`)
    added to the system server. Read is classified `observe` (auto-runs with the user
    present) but a new `UNATTENDED_BLOCKED_OBSERVE` set in policy hard-blocks it on an
    unattended run with "may expose secrets" - so an injected trigger can never slurp a
    password/2FA code off the clipboard, even though the class is observe. Write is
    `reversible` (auto-run present, blocked unattended like open_path). The write text
    rides into PowerShell via `$env:JUNE_CLIP_VALUE` (a new `env` arg on `runPwsh`),
    NEVER interpolated into the script body, so a copied string can't inject PowerShell.
    Pure `formatClipboard` trims the trailing newline and caps at 10k chars so a giant
    paste can't flood the pipe/voice reply. Windows-only (clear error elsewhere).
    Pinned: parse.test (trim + cap), policy.test (read observe + unattended-blocked,
    write reversible + summaries). Full system + policy suites green, typecheck +
    eslint clean.

4.8 **Catalog presets: calendar, Google Workspace, `fetch_url`** | P1-P3 | S - DONE
    Pure catalog data, zero core code: a read-only calendar entry (the 9am briefing
    currently has nothing personal to say), the Google Workspace presets improvement-4's
    own acceptance scenario assumes, and a pinned fetch-style page reader so non-Claude
    brains can "read me that article". `src/lib/mcp-servers.ts::MCP_CATALOG`.
    Three new `MCP_CATALOG` rows, zero core code (they are just entries a user adds):
    (1) **Fetch** - the official reference `mcp-server-fetch` (Python, `uvx
    mcp-server-fetch@2026.7.10`), read-only -> `defaultClass: observe`, so a non-Claude
    brain can read an article; (2) **Google Calendar (read-only)** -
    taylorwilsdon/google_workspace_mcp scoped `--tools calendar --read-only` (write
    tools disabled), `defaultClass: observe`, so "what's on my calendar today"; (3)
    **Google Workspace** - the full `--tool-tier core` surface (Gmail/Calendar/Drive/
    Docs), shipped `enabled: false` (broad, write-capable) with `defaultClass` UNSET so
    writes/sends fail closed to gated and the user promotes reads (same stance as
    GitHub). All three are `offlineSafe: false` (networked Google/web APIs), so strict
    offline drops them and an unattended run still can't call them (networked observe is
    blocked - calendar reads happen with the user present). Versions PINNED per 13.5:
    `workspace-mcp@1.22.0` and `mcp-server-fetch@2026.7.10` (both confirmed live on
    PyPI). Both use `uvx`, so the catalog-pinning test was extended to require an
    `@version` for uvx as well as npx. mcp-servers suite green, full typecheck + eslint
    clean.

4.9 **Read agent/terminal output through the bridge** | P2 | M - DONE (June side; bridge endpoint external)
    June can spawn agents but cannot answer "what is agent 3 doing?", and mission verify
    grades replies, never actual output. Observe-class `read_terminal(pane_id, tail)` in
    the contract + bridge server; needs the matching saple-bridge endpoint first.
    `src/contract/types.ts`, `mcp/saple-bridge-control/`.
    Added `read_terminal` to the frozen contract `ACTIONS` (NOT `MUTATING_ACTIONS` - it
    is non-mutating like `get_swarm_status`, so it needs no request_id dedupe, only a
    correlation id) and to the golden `capabilities.json` (the contract test pins the
    two in step). New `read_terminal(pane_id, tail?)` MCP tool on saple-bridge-control
    mirrors get_swarm_status: it sends the contract command and passes bridge's response
    verbatim; `tail` is capped at 2000 lines so a huge scrollback can't flood the pipe.
    Classified `observe` in policy (auto-runs, and safe unattended - it is a LOCAL bridge
    read, so a mission can grade actual terminal output, not just the agent's reply) with
    a summarize case ("Read terminal p3"). The June side is complete; the actual read is
    served by saple-bridge, whose matching `read_terminal` endpoint is external to this
    repo (bridge returns `invalid_request` until it ships it - the frozen error path).
    Pinned: contract.test (read_terminal in ACTIONS, not mutating, validates w/o
    request_id), policy.test (observe + auto-run + unattended-allowed + summary). Full
    contract + policy suites green, typecheck + eslint clean.

4.10 **Start missions by voice** | P2 | M - DONE
    The flagship autonomy feature still starts from a textarea (deferred twice). Add a
    gated `start_mission` tool to the automation server writing a pending-mission request;
    the scheduler tick picks it up and calls the same path as the `start_mission` command.
    Classify `expensive`. `mcp/automation/`, `src-tauri/src/missions.rs`, `scheduler.rs`.
    New `start_mission(outcome, tasks[], toolsetIds?, verify?)` tool on the automation
    server: the brain decomposes the goal into ordered task titles and the tool pushes a
    validated request onto a `pendingMissions` queue in settings.json (pure
    `coercePendingMission` + `withPendingMission` in store.ts - trims/drops empty tasks,
    defaults verify=true, rejects an empty goal/plan up front). Classified `expensive` in
    policy, so it is GATED (spoken-approvable - June never silently starts a paid run)
    AND, being expensive, blocked on any UNATTENDED run (18.2) - a scheduled/watch/trigger
    run can never spawn a mission. summarize renders "Start a mission: <goal> (N tasks,
    paid)". The Rust `start_mission` command body was extracted into a `State`-free
    `start_mission_from(...)` so the command (webview plan-confirm) and the new voice path
    share the exact same build-and-spawn logic. New `settings::take_pending_mission` pops
    ONE request FIFO per tick (atomic read-modify-write; a write failure leaves it queued
    rather than looping). The scheduler thread now takes the `MissionRunner` (wired in
    lib.rs) and, each tick when neither the session nor the runner is busy, dequeues and
    starts one queued mission via `start_mission_from` (a busy tick leaves it queued to
    retry; a malformed entry is dropped with a notify, never re-parsed into a loop). A new
    `MissionRunner::running()` accessor backs the busy check. Pinned: store.test (coerce
    trim/defaults/reject + queue append preserving keys), policy.test (expensive + gated +
    unattended-blocked + summary), settings.rs test (FIFO head-pop persists the rest and
    preserves other keys). Full suite: 283 vitest + 43 cargo green, typecheck + eslint +
    clippy `-D warnings` clean.

---

## Phase 5 - Missions and scheduling grow up

5.1 **Fix the schedule-starvation window** | P2 | M - DONE
    `fire()` runs whole agent turns inline in the tick thread; a 30+ minute run pushes a
    sibling schedule past `CATCHUP_MINUTES` and its day is silently skipped. Snapshot
    due-ness at window entry and honor it after the window closes (or at least notify).
    `src-tauri/src/scheduler.rs`.
    The tick thread now tracks `last_tick` (the `now` of the previous LIVE tick,
    `None` until the first tick completes) and threads it into `is_due`. A schedule
    whose fire moment fell in the unobserved gap `(last_tick, now]` - a gap a long
    inline `fire()` can stretch far past the fixed 30-min catch-up - is still
    honoured even though the fixed window has since closed. New pure
    `in_catchup_or_gap(now, scheduled, last_tick)` is the shared rule for both
    `daily_due` and `once_due` (`every` is interval-based, so it never starves).
    On a fresh launch (`last_tick` None) only the fixed catch-up applies, so an
    evening launch still never replays the morning's 9am run, and a schedule whose
    moment predates the last live tick is not resurrected. Pinned: a new
    `honours_a_schedule_that_came_due_during_a_blocked_gap` test (35-min-late daily
    lost without the gap, honoured with it; stale/not-yet-due not fired; once
    honoured through the same gap). 13 scheduler tests + clippy `-D warnings` green.

5.2 **"Retry failed tasks" on a finished board** | P2 | S - DONE
    A failed mission offers only "Clear" - the user re-types everything even though the
    board holds the failed titles and notes. Button that calls `start_mission` with just
    the failed tasks, notes appended as context. `src/app/MissionBoard.tsx`.
    A finished board with any failed task now shows "Retry failed task(s)" beside
    Clear. It calls `start_mission` with the same outcome and this mission's
    `toolsetIds`, passing ONLY the failed titles - each carrying its verify note as
    context ("(A previous attempt failed: <note>)"), not an instruction. Verify is
    on so the retried tasks are re-checked. The runner's double-start guard makes it
    safe (the board is terminal, so the runner is idle); the new board replaces the
    old via `mission://updated`. A start error surfaces inline.

5.3 **Pause/resume a mission** | P3 | M - DONE
    Stop is destructive (fails the active task, closes the board) - "hold on while I take
    this call" costs the mission, even though the runner already resumes across restarts.
    Paused flag on `MissionRunner`, board stays `active` and persisted.
    `src-tauri/src/missions.rs`, `MissionBoard.tsx`.
    New `paused: Arc<AtomicBool>` on `MissionRunner`. `run_board` waits BETWEEN
    tasks via a widened `wait_until_ready` (holds while the session is busy OR
    paused, returns at once on cancel), so an in-flight task finishes and the NEXT
    won't start until resumed - the board stays `active` and persisted, nothing
    fails. New `set_mission_paused(paused)` + `mission_paused()` commands; the toggle
    emits `mission://paused` and `spawn`/`stop` reset it (a fresh mission never
    inherits a stale pause; Stop wakes a paused loop so it can close out). Frontend:
    `useMissionPaused` hook (seeds via `mission_paused`, tracks the event) drives a
    Pause/Resume button beside Stop and a "Paused - will resume after: <task>"
    status. Memory-only, so a restart resumes unpaused (the runner already resumes
    the active board).

5.4 **Single writer for the mission board** | P3 | S - DONE
    `stop_mission` read-modify-writes june-mission.json from the command thread while
    `run_board`'s thread persists per task - an interleave can resurrect a stopped board.
    Make Stop flag-only; `run_board` writes the terminal board itself.
    `src-tauri/src/missions.rs`.
    `stop_mission` now only flags `cancelled` (+ aborts the in-flight turn, clears
    pause) when a runner thread is alive; that thread, seeing `cancelled` after its
    loop, calls `stop_board` + `persist` ITSELF - so no command-thread write can
    interleave with a per-task persist and resurrect a stopped board. Only when NO
    runner is alive (a stale `active` board from a dead session) does Stop do the
    read-modify-write, where there is no competing writer. A normal finish still
    reaches terminal via `advance`; the cancel-path write is guarded on `cancelled`.

5.5 **Plan-confirm polish: editable toolset + per-watch cap** | P3 | S - DONE
    Toolset list becomes checkboxes over enabled server ids (a wrong `TOOLS:` guess can't
    be corrected today); `WatchLoop` gets optional `maxChecks` (a 1-minute watch dies in
    ~30 min while a 60-minute watch runs 30 hours). `MissionBoard.tsx`,
    `src/lib/schedules.ts`, `scheduler.rs`.
    (a) The plan-confirm view now carries every enabled server id (`Plan.serverIds`)
    and renders the toolset as editable checkboxes (June's `TOOLS:` guess pre-checked,
    the user can correct it). None checked = all enabled tools (the existing empty-
    toolsetIds = no-filter semantics), stated in a hint. (b) `WatchLoop` gains an
    optional `maxChecks`, coerced in `coerceWatches` (>=1, clamped to 10,000, omitted
    when absent/garbled so the scheduler default applies). The Rust `Watch` reads
    `maxChecks` and the retire logic uses `w.max_checks.unwrap_or(MAX_WATCH_ITERS)`
    for both the DONE-cap and the error-cap, so an existing watch with no cap behaves
    exactly as before. A "Stop after N checks" field (blank = 30) on the watch card in
    SettingsPanel. Pinned: schedules.test (cap kept / sub-1 & absent omitted / huge
    clamped). Full suite 284 vitest + 13 scheduler cargo tests + clippy green.

---

## Phase 6 - UI/UX polish

6.1 **Settings navigation** | P1 | M - DONE
    Twelve sections in one endless scroll. Sticky in-page section nav (anchors +
    `scroll-margin-top`) or 3-4 sub-tabs (Voice / Conversation / Capabilities /
    Automation). Pure layout. `src/app/SettingsPanel.tsx`, `src/styles.css`.
    Went with the sticky anchor nav (simpler than sub-tabs, keeps one scroll and
    zero routing state). Each of the twelve sections is wrapped in a
    `.settings-anchor` (id + `scroll-margin-top: 52px` so a jumped-to heading clears
    the bar); a new `SectionNav` renders a `position: sticky; top` bar of buttons
    driven by a `NAV_SECTIONS` list, each calling `scrollIntoView({behavior:"smooth"})`.
    The bar bleeds to the scroll-container edges (negative margins) with a blurred
    translucent background. Pure layout, no state.

6.2 **Automation cards: next-fire time + last outcome** | P2 | S/M - DONE
    Cards are write-only - no confirmation the config parses into what was meant, no idea
    whether last night's run worked. Pure `describeNext(schedule, now)` in
    `src/lib/schedules.ts` (unit-testable TS mirror of `is_due`) + last matching ledger
    entry per card. `SettingsPanel.tsx`, `src/lib/runs.ts`.
    New pure `describeNext(schedule, now)` in schedules.ts: a forward-looking mirror of
    the Rust `is_due` clock - `daily` resolves the next matching-weekday "HH:MM" to
    "Next today/tomorrow/Fri 09:00", `once` renders "Reminder <when>" (or "already fired
    or missed"), `every` reports its interval (no clock anchor the UI can know). New
    `lastRunFor(runs, source)` + shared `relativeTime(ts)` in runs.ts (the latter hoisted
    out of RunsPanel so both surfaces share it). A `CardStatus` component under each
    schedule/trigger/watch card shows the next fire (schedules + watch interval) and the
    last matching ledger outcome ("✓ last ran 5m ago", "✗ ... (2 blocked)", or "no runs
    yet"), matched by the `schedule:`/`trigger:`/`watch: <label>` source prefix (a
    "(run now)" suffix still matches). A `useRuns` hook refreshes on `runs://updated`.
    Pinned: schedules.test (describeNext daily/tomorrow-roll/weekday/every/once-future+past).

6.3 **Composer: grow with content, keep newlines, recall history** | P2 | S - DONE
    `rows={1}` with a fixed 38px box hides the second line Shift+Enter creates, and
    `.turn.you` lacks `white-space: pre-wrap` so sent newlines collapse. Add
    `field-sizing: content`, the missing CSS rule, and ArrowUp-recalls-last-command.
    `src/app/AppWindow.tsx`, `src/styles.css`.
    `field-sizing: content` on the composer textarea (bounded by the existing
    min/max-height) grows it to fit a multi-line draft; `.turn.you` gained
    `white-space: pre-wrap` so a sent Shift+Enter newline survives. ArrowUp from an
    EMPTY box recalls the last sent command (kept in a `lastSent` ref, raw text with
    newlines) - guarded on empty so ArrowUp still navigates lines within a draft.

6.4 **First-run onboarding** | P2 | M - DONE
    A fresh install is an unexplained floating dot. One-time welcome card (a
    `firstRunDone` flag): test your mic, verify the PTT chord, pick a privacy mode - all
    reusing existing SettingsPanel controls. `src/app/AppWindow.tsx`, `src/lib/settings.ts`.
    New `firstRunDone` setting (false on a fresh install or a pre-flag file, coerced
    like the other bools). A modal `Onboarding` card over the app window shows while
    it's false: what June is + how to talk to it (the live PTT chord via `usePttLabel`),
    a privacy-mode radio group up front (the one choice that changes what leaves the
    device - written straight through `saveSettings`), and two dismiss buttons ("Open
    Settings to test your mic" routes into the Settings view, which already owns the mic
    test - so we reuse that control rather than duplicate it; "Start using June" just
    dismisses). Either dismiss flips `firstRunDone` and persists, so it never shows again.
    ponytail: the mic test lives one click away in Settings rather than inlined into the
    card - the card points at it instead of re-mounting the capture control.

6.5 **Bubble timestamps + copy button** | P3 | S - DONE
    Replies contain paths and commands; the only route out is manual selection.
    Hover-revealed copy + small timestamp on `.turn.june`. `src/app/AppWindow.tsx`.
    Each `june` entry now carries an `at` epoch stamped when the bubble is first
    created (delta or final). A `JuneBubble` renders the reply plus a `.turn-meta` row:
    an always-visible small local-time stamp and a Copy button revealed on hover/
    focus-within (`navigator.clipboard.writeText`, flips to "Copied" for ~1.2s). The
    bubble became a flex column so the meta reserves its own row - no layout shift on
    hover, and the copy button stays keyboard-reachable via `:focus-within`.

6.6 **Keyboard routes between views** | P3 | S
    Ctrl+1..4 for the four tabs, `/` to focus the composer. One window-level keydown
    listener, mirroring `useApprovalKeys`. `src/app/AppWindow.tsx`.

---

## Phase 7 - Performance and hardening

7.1 **Add `[profile.release]` to Cargo.toml** | P1 | S
    There is none - cargo defaults (no LTO, 16 codegen units, no strip). `lto = true`,
    `codegen-units = 1`, `strip = true`, `panic = "abort"`, `opt-level = "s"`; typically
    cuts the exe 30-50%. `src-tauri/Cargo.toml`.

7.2 **Gate wake-word inference behind VAD** | P1 | M
    The 3-model ONNX chain runs on every 80ms frame 24/7 even in silence - the dominant
    idle-CPU cost. Feed the wake model only while `speechActive`, replaying a small
    pre-roll on speech start so the phrase onset isn't lost. `src/lib/wakeword.ts`,
    `src/lib/vad.ts`.

7.3 **Lazy-load the window faces** | P2 | S
    The 88x88 widget parses SettingsPanel/MissionBoard/RunsPanel code it never renders
    (302KB entry chunk). `React.lazy` per `getCurrentWindow().label`. `src/main.tsx`.

7.4 **Scheduler: skip the 30s settings re-parse when mtime is unchanged** | P2 | S
    It already stats the mtime three lines later. Hoist the stat, reuse the last parsed
    value. `src-tauri/src/scheduler.rs`.

7.5 **Isolate the 11Hz waveform re-render** | P2 | M
    The level-poll re-renders all of VoicePanel (transcript, chips, approvals) every 90ms
    while listening. Extract waveform + orb glow into a child that owns the interval.
    Same pattern for the SettingsPanel mic meter. `src/voice/VoicePanel.tsx`.

7.6 **`read_runs`: parse the tail, not 4MB** | P2 | S
    Both ledger generations are fully read and every line JSON-parsed to keep 200 records.
    Take the last 200 raw lines first, parse only those. `src-tauri/src/agent_runner.rs`.

7.7 **Single writer for settings.json** (x2: rust + reliability) | P2 | M
    Rust `save_settings` (whole-bag, last-writer-wins) races the automation server's
    out-of-band writes - a voice-created schedule can be silently dropped by a concurrent
    Settings save. Merge-on-save: re-read disk and overlay only webview-owned keys (or
    route automation mutations through a Rust command); emit `settings://changed` from
    Rust on disk change. `src-tauri/src/settings.rs`, `mcp/automation/store.ts`.

7.8 **Consolidate duplicated plumbing** | P2 | S-M
    (a) One `fsutil` module for the 5x hand-rolled atomic write (fixed tmp names can
    collide) and 2x JSONL rotation. (b) Extract one `run_turn` core from the three
    copy-pasted turn pipelines (`run_agent`/`run_attended`/`run_unattended`) so the next
    fix lands once. (c) Async keychain wrapper so blocking credential reads leave the
    tokio runtime (stt/tts/diagnostics call it directly today).
    `src-tauri/src/agent_runner.rs`, `settings.rs`, `scheduler.rs`, `missions.rs`,
    `keychain.rs`.

7.9 **Scrub brain API keys from MCP child env** | P1 | M
    All five built-in servers inherit `process.env` including `ANTHROPIC_API_KEY`; whether
    user-added generic stdio servers also receive it is unverified. Scrubbed base env for
    every MCP config; verify + pin with a test. `agent/core.ts`, `src/lib/mcp-servers.ts`.

7.10 **Bind `inject_text` to a live PTT session** | P2 | S
    The command types into whatever has OS focus and is invokable by any webview script -
    the "only after PTT" safety is convention, not enforced. Atomic flag set on
    `ptt://down`, cleared after `ptt://up`; refuse otherwise. `src-tauri/src/dictation.rs`,
    `lib.rs`.

7.11 **Retention controls for recorded activity** | P2 | S
    audit.jsonl and june-runs.jsonl hold verbatim params/prompts indefinitely with no view
    or clear path. `clear_recorded_data` command + "Clear recorded activity" button next
    to the privacy picker, with retention stated. `src-tauri/src/agent_runner.rs`,
    settings UI.

7.12 **Keychain hygiene + CSP tightening** | P3 | S
    Toast on `keychain://changed`, restrict key mutation to the app window; gate the four
    wildcard huggingface `connect-src` origins behind the model-download flow and try
    dropping `style-src 'unsafe-inline'`. `src-tauri/src/keychain.rs`,
    `src-tauri/tauri.conf.json`.

7.13 **Guard the seams with cheap tests** | P3 | S
    Provider/keychain-service metadata is duplicated across Rust and TS with only a
    comment keeping it honest - a vitest that greps the Rust source pins it. One
    tauri-driver E2E smoke spec (launch, both windows respond, one stubbed turn) catches
    the orphaned-webview class no unit test can. `src/lib/providers.test.ts`, new `e2e/`.

---

## Phase 8 - Ambient assistant (bigger bets)

8.1 **Away digest (presence-aware return briefing)** | P1 | M
    June accumulates ledger entries, blocked approvals and trigger firings while you're
    gone - but you must dig in the Runs tab. Idle detection via `GetLastInputInfo` in the
    existing 30s tick; on return after N idle minutes, one compact "while you were away"
    card + optional spoken one-liner. Pure aggregation over existing data.
    `src-tauri/src/scheduler.rs`, `src/lib/runs.ts`, `src/widget/WidgetWindow.tsx`.

8.2 **Image paste/drop in the composer** | P1 | M
    Pasting an error-dialog screenshot and asking "why?" is the modern-assistant baseline
    and sidesteps the blocked auto-capture path - the user supplies the pixels. Accept
    clipboard/drag images, ship as an image content block; gate under privacy modes
    (cloud-only first). Composer component, both brains, `agent/serve.ts` message shape.

8.3 **SAPLE morning standup template** | P2 | S
    June sits on saple-memory (swarm status, incidents, tasks) but nothing composes it.
    One-click schedule template whose prompt walks `get_swarm_status`/`list_incidents`/
    `list_tasks` into a spoken 30-second digest - a curated prompt, not new machinery.
    `SettingsPanel.tsx` template picker, `agent/prompt.ts`.

8.4 **Owner voice verification** | P3 | L
    An always-listening mic that obeys anyone in the room is a real trust gap. Local
    speaker-embedding model (ECAPA/onnx beside the existing Silero/whisper ORT stack),
    one-time enrollment; below-threshold voices get wake acknowledgment but observe-only.
    Fully local, survives strict offline. `src/lib/wakeword.ts`, `ort-assets.ts`,
    `SettingsPanel.tsx`.

---

## Suggested order of attack

1. Phase 1 in one sitting - it is almost all S-effort and removes real crashes, leaks and
   safety holes (1.1 CI fix first, so everything after runs under green checks).
2. Phase 2 next - every later phase benefits from logs, a live ledger and honest errors.
3. Phase 3.1-3.5 + 4.1-4.2 as the first feature drop (latency wins + the two most-asked
   voice verbs).
4. Then interleave Phases 4-7 by taste; Phase 8 items are independent and can ride along
   whenever their neighbors are touched.

## Explicitly not proposed

Already planned elsewhere: sidecar packaging (P3.2), keychain-backed MCP secrets (P3.4),
unattended conversation isolation (P3.1), approvals inbox (P3.3), SSE streaming for OpenAI
(P3.7), screen grounding via display capture (17.4), context trimming (P3.9).

Verified sound during the security pass (no action needed): keychain service-name
validation, fail-closed unknown-tool classification, the unattended leash ordering,
files-server path containment incl. symlinks, trigger-payload quarantine and fencing,
cloud STT/TTS refusal under on-device modes, and uniform gate wiring in both brains.
