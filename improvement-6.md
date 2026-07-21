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

3.1 **One shared `reqwest::Client`** | P1 | S
    STT, TTS and diagnostics each build a fresh client (new pool + TLS handshake) per
    call - on both voice legs of every turn. `static OnceLock<Client>` with per-request
    timeouts. `src-tauri/src/stt.rs`, `tts.rs`, `diagnostics.rs`.

3.2 **Move local STT/TTS inference off the webview main thread** | P1 | M
    `numThreads: 1`, no worker proxy - Moonshine and every Kokoro sentence freeze the
    widget UI and stall barge-in Silero inference. Set ORT `proxy: true` in
    `src/lib/xformers.ts` (or wrap in a Web Worker); verify barge-in latency before/after.

3.3 **Persistent audio front-end: shared mic stream + warm VAD + pre-roll ring buffer** | P1 | L
    Every phase transition reopens `getUserMedia` and a fresh `MicVAD` (100-400ms each on
    Windows), re-warms the wake buffer, clips first words after wake, and caused the
    documented follow-up clip and `openingMic` race guards. Own the stream once in a
    `mic.ts` manager with a rolling ~1s 16kHz ring buffer; capture/wake/barge/follow-up
    attach listeners instead of reopening; prepend the ring buffer to wake-started
    captures. `src/lib/voice-capture.ts`, `wake.ts`, `vad.ts`, `src/voice/VoicePanel.tsx`.

3.4 **Barge-in while thinking** | P2 | S
    The barge monitor only arms on `speaking`; during long tool calls speech does nothing.
    Extend the condition to `thinking || speaking` - the callback already handles both.
    `src/voice/VoicePanel.tsx`.

3.5 **Cache canned TTS phrases** | P2 | S
    "On it." / "Okay, cancelled." are re-synthesized (cloud round-trip or Kokoro run) on
    every occurrence. Small keyed memo in `synthesize()`. `src/lib/tts.ts`.

3.6 **Claude streaming: real deltas, not whole blocks** | P2 | M
    `onText` fires once per finished block, inflating time-to-first-audio against the
    800ms target. Set `includePartialMessages: true` and emit `stream_event` deltas,
    keeping the block path as dedupe fallback. `agent/claude-brain.ts`.

3.7 **Retry transient completion errors** | P2 | S
    One 429/network blip kills the spoken turn. Retry 429/5xx once or twice in
    `#complete`, honor `Retry-After`, bail on abort and 4xx auth. `agent/openai-brain.ts`.

3.8 **Give the model a clock** | P2 | S
    Nothing injects the current date/time, yet June creates "daily at 9am" schedules and
    answers "what day is it" blind. One line per turn in `runTurn`, outside the fenced
    untrusted blocks. `agent/serve.ts`.

3.9 **Audio output device picker** | P2 | S
    Mic picker shipped (6.5) but TTS speaks on system default - headset users get AEC
    fighting a different device. `outputDeviceId` setting + `setSinkId()` in
    `SpeechQueue.#play`. `src/lib/tts.ts`, `settings.ts`, `SettingsPanel.tsx`.

3.10 **Train and ship the real "hey june" wake model** | P2 | M
    The local wake phrase is literally "hey jarvis" (openWakeWord stand-in). Train
    `hey_june.onnx` per the openWakeWord recipe, pin its SHA-256 in
    `scripts/fetch-models.mjs`, drop into `createWakeRunners`.

3.11 **Abort in-flight synthesis on barge-in** | P3 | S
    `SpeechQueue.stop()` drops the queue but running synth promises keep spending cloud
    tokens and burning the main thread right when the next capture needs it. Thread an
    aborted flag + cancel down to Rust `synthesize`. `src/lib/tts.ts`, `local-tts.ts`,
    `src-tauri/src/tts.rs`.

3.12 **Stream cloud TTS playback** | P3 | M
    First audio waits for the complete first-sentence mp3. Chunk the response body over a
    Tauri channel into a MediaSource buffer. Only do it if Diagnostics shows p50 tts
    meaningfully above ~300ms. `src-tauri/src/tts.rs`, `src/lib/tts.ts`.

---

## Phase 4 - New capabilities (what June can do)

4.1 **One-shot reminders and timers: `kind: "once"`** (x2: product + tools) | P0 | S
    "Remind me in 20 minutes" is daily-driver table stakes and only a schedule kind away.
    Add `once` with an absolute fire time to `Schedule`, teach `is_due` to fire-then-
    disable, extend the automation server's zod schema and `summarize()`. On fire, speak
    via TTS + OS notification - no agent turn needed for a plain reminder.
    `src/lib/schedules.ts`, `src-tauri/src/scheduler.rs`, `mcp/automation/server.ts`,
    `agent/policy.ts`.

4.2 **Voice management verbs: remove / enable / disable automations** (x2) | P1 | S
    The automation server can create but never manage - "stop the build watch" is
    impossible by voice. Add `set_automation_enabled` + `remove_automation` (match by id
    or label), classify `reversible`; cover triggers too. `mcp/automation/server.ts`,
    `store.ts`, `agent/policy.ts`.

4.3 **`mcp/system` observe pack** | P1 | M
    Unattended watch loops may only call local observe tools, which today means the files
    root or the bridge roster - "watch until the build is green" barely has eyes. New
    built-in server: `list_processes`, `process_running(name)`, `system_stats`. Register
    in `BUILTIN_SERVERS`, `RESERVED_IDS`, `ACTION_CLASS` as observe.
    New `mcp/system/`, `agent/policy.ts`, `src/lib/mcp-servers.ts`, `agent/core.ts`.

4.4 **Foreground-context awareness (metadata, not pixels)** | P1 | S/M
    90% of "what am I looking at" is answerable from window metadata; no display capture
    needed. Observe-class `get_active_context`: Win32 `GetForegroundWindow` title +
    process name (+ browser tab URL via UI Automation later). Local-only, works under
    strict offline, audit-logged. New `src-tauri/src/context.rs`, `agent/policy.ts`.

4.5 **Quick-capture voice inbox** | P1 | S
    A sub-second "jot this down" path: second hotkey mode, speak -> local STT -> append a
    timestamped line to `june-inbox.md` (same contained-path pattern as memory), chime
    confirm, no brain in the loop. Optional "capture as task" via saple-memory
    `create_task`. `src-tauri/src/dictation.rs`, `src/lib/hotkey.ts`, `SettingsPanel.tsx`.

4.6 **`open_path` / app launcher in `mcp/system`** | P2 | S
    Standalone June (no saple-bridge) cannot open a URL, file or app at all. `cmd /c start`
    node-side, classify `reversible`, validate the target is a plain path/URL before
    shelling out. `mcp/system/server.ts`, `agent/policy.ts`.

4.7 **Clipboard capability** (x2) | P2 | S
    "What's on my clipboard?" via `Get-Clipboard`/`Set-Clipboard` in `mcp/system` - zero
    new deps. Read is observe-class but hard-blocked for unattended runs (clipboards hold
    passwords); write is reversible. `mcp/system/server.ts`, `agent/policy.ts`.

4.8 **Catalog presets: calendar, Google Workspace, `fetch_url`** | P1-P3 | S
    Pure catalog data, zero core code: a read-only calendar entry (the 9am briefing
    currently has nothing personal to say), the Google Workspace presets improvement-4's
    own acceptance scenario assumes, and a pinned fetch-style page reader so non-Claude
    brains can "read me that article". `src/lib/mcp-servers.ts::MCP_CATALOG`.

4.9 **Read agent/terminal output through the bridge** | P2 | M
    June can spawn agents but cannot answer "what is agent 3 doing?", and mission verify
    grades replies, never actual output. Observe-class `read_terminal(pane_id, tail)` in
    the contract + bridge server; needs the matching saple-bridge endpoint first.
    `src/contract/types.ts`, `mcp/saple-bridge-control/`.

4.10 **Start missions by voice** | P2 | M
    The flagship autonomy feature still starts from a textarea (deferred twice). Add a
    gated `start_mission` tool to the automation server writing a pending-mission request;
    the scheduler tick picks it up and calls the same path as the `start_mission` command.
    Classify `expensive`. `mcp/automation/`, `src-tauri/src/missions.rs`, `scheduler.rs`.

---

## Phase 5 - Missions and scheduling grow up

5.1 **Fix the schedule-starvation window** | P2 | M
    `fire()` runs whole agent turns inline in the tick thread; a 30+ minute run pushes a
    sibling schedule past `CATCHUP_MINUTES` and its day is silently skipped. Snapshot
    due-ness at window entry and honor it after the window closes (or at least notify).
    `src-tauri/src/scheduler.rs`.

5.2 **"Retry failed tasks" on a finished board** | P2 | S
    A failed mission offers only "Clear" - the user re-types everything even though the
    board holds the failed titles and notes. Button that calls `start_mission` with just
    the failed tasks, notes appended as context. `src/app/MissionBoard.tsx`.

5.3 **Pause/resume a mission** | P3 | M
    Stop is destructive (fails the active task, closes the board) - "hold on while I take
    this call" costs the mission, even though the runner already resumes across restarts.
    Paused flag on `MissionRunner`, board stays `active` and persisted.
    `src-tauri/src/missions.rs`, `MissionBoard.tsx`.

5.4 **Single writer for the mission board** | P3 | S
    `stop_mission` read-modify-writes june-mission.json from the command thread while
    `run_board`'s thread persists per task - an interleave can resurrect a stopped board.
    Make Stop flag-only; `run_board` writes the terminal board itself.
    `src-tauri/src/missions.rs`.

5.5 **Plan-confirm polish: editable toolset + per-watch cap** | P3 | S
    Toolset list becomes checkboxes over enabled server ids (a wrong `TOOLS:` guess can't
    be corrected today); `WatchLoop` gets optional `maxChecks` (a 1-minute watch dies in
    ~30 min while a 60-minute watch runs 30 hours). `MissionBoard.tsx`,
    `src/lib/schedules.ts`, `scheduler.rs`.

---

## Phase 6 - UI/UX polish

6.1 **Settings navigation** | P1 | M
    Twelve sections in one endless scroll. Sticky in-page section nav (anchors +
    `scroll-margin-top`) or 3-4 sub-tabs (Voice / Conversation / Capabilities /
    Automation). Pure layout. `src/app/SettingsPanel.tsx`, `src/styles.css`.

6.2 **Automation cards: next-fire time + last outcome** | P2 | S/M
    Cards are write-only - no confirmation the config parses into what was meant, no idea
    whether last night's run worked. Pure `describeNext(schedule, now)` in
    `src/lib/schedules.ts` (unit-testable TS mirror of `is_due`) + last matching ledger
    entry per card. `SettingsPanel.tsx`, `src/lib/runs.ts`.

6.3 **Composer: grow with content, keep newlines, recall history** | P2 | S
    `rows={1}` with a fixed 38px box hides the second line Shift+Enter creates, and
    `.turn.you` lacks `white-space: pre-wrap` so sent newlines collapse. Add
    `field-sizing: content`, the missing CSS rule, and ArrowUp-recalls-last-command.
    `src/app/AppWindow.tsx`, `src/styles.css`.

6.4 **First-run onboarding** | P2 | M
    A fresh install is an unexplained floating dot. One-time welcome card (a
    `firstRunDone` flag): test your mic, verify the PTT chord, pick a privacy mode - all
    reusing existing SettingsPanel controls. `src/app/AppWindow.tsx`, `src/lib/settings.ts`.

6.5 **Bubble timestamps + copy button** | P3 | S
    Replies contain paths and commands; the only route out is manual selection.
    Hover-revealed copy + small timestamp on `.turn.june`. `src/app/AppWindow.tsx`.

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
