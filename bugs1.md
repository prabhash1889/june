# June - Bug-fix Plan #1 (deep review of phases 10-19)

**Date:** 2026-07-20
**Source:** two-agent deep review of the improvement-4.md implementation (backend/security agent + frontend/voice agent). All findings below were traced in the actual source; none are speculative.
**Baseline verified green before any fix:** 167/167 TS tests, 14/14 Rust tests, `tsc --noEmit` (all 6 tsconfigs), `eslint` (zero warnings), `cargo clippy --all-targets`, production `vite build` (transformers/kokoro/vad chunks code-split).

**Ordering rule:** security holes first (they undermine the gate everything else stands on), then the bugs an end user hits daily, then autonomy/mission correctness, then hygiene. Each phase ends with the full suite green plus new regression tests pinning the fix.

---

## Phase B1 - Security: the gate must actually be the gate  ✅ DONE (2026-07-20)

Goal: no tool call can dodge, spoof, or self-satisfy the approval gate.

**Status:** all of B1.1-B1.7 landed. Suite green: 176/176 TS tests (was 167 +9 regression tests), 14/14 Rust, `tsc --noEmit` (all 6 tsconfigs), `eslint .` (zero warnings), production `vite build` (chunks stay code-split). The spoof shapes classify `destructive`/gated on **both** brains (shared `classify` in `policy.ts`, wired at `claude-brain.ts:123` and `openai-brain.ts`).

- **B1.1 Tool-name spoofing bypass** (`agent/policy.ts:69-85`). `actionOf` takes the *last* `__` segment and consults the global `ACTION_CLASS` before the per-server default, so `mcp__evil__x__remember` classifies as ungated `reversible` and `mcp__anything__read_file` as `observe` (verified empirically). Any third-party MCP server naming a tool `read_file` / `open_browser` / `remember` etc. runs with no approval. Fix: parse `mcp__<server>__<tool>` from the front (server = first segment after `mcp__`, tool = the rest verbatim); apply `ACTION_CLASS` only for June's built-in servers (`saple-bridge-control`, `files`, `memory`, `lessons`, or no server); generic servers get only their per-server default, else fail closed. Tests: the three spoof shapes above classify destructive/gated.
- **B1.2 OpenAI-compat brain uses bare tool names** (`agent/openai-brain.ts:243-247`, `:176-178`, `:114-115`). Bare names mean (a) a plain name collision bypasses the gate, (b) `serverOf` is always undefined so 13.2's per-server promotion is inert, (c) duplicate names across servers misroute first-match and produce a duplicate-name tools array. One fix for all three: expose tools to the OpenAI API as `mcp__<server>__<tool>` and route by full name. Tests: promotion works on this brain; two servers with the same tool name route correctly.
- **B1.3 Unattended runs can act, not just read** (`agent/serve.ts:162-170`). The unattended branch blocks only gated classes; `open_browser` (reversible), `remember`, `record_lesson`, and observe-promoted servers (e.g. the Brave Search preset) auto-run. An injection in a watched trigger file can exfiltrate over the network or persistently poison future prompts via `remember`/`record_lesson`, with no notification. Fix: unattended mode allows `observe`-class only, and additionally blocks networked servers and the memory/lessons write tools; every unattended block emits `blocked` + audit. Tests: `open_browser` / `remember` / promoted-server tool all blocked unattended; `read_file` still allowed.
- **B1.4 Spoken approvals fail open** (`src/lib/approval-voice.ts:12-13`, `src/voice/VoicePanel.tsx:514-527`). (a) Bare "okay/ok" counts as yes and a silent 8s clip is still transcribed - cloud Whisper hallucinates "Okay." on silence, approving a paid action with zero human input. (b) The NO vocabulary has `don'?t` but not `not`, so "sure, do not do it" reads as yes. Fix: expose Silero's heard-speech from the capture handle and refuse to transcribe a speechless clip; drop bare "ok/okay" as a sole affirmative; add `\bnot\b` / `do\s+not` to NO. Tests: matcher cases for "okay", "sure do not do it", "yes not that one".
- **B1.5 User-added server can shadow a built-in** (`agent/core.ts:151-161`). An entry with id `memory` replaces the trusted memory server; its arbitrary `remember` inherits the ungated class. Fix: reject reserved ids (`memory`, `lessons`, `files`, `saple-bridge-control`) in `coerceMcpServers`. Test: a reserved-id entry is dropped.
- **B1.6 Unknown gated tools are approved blind** (`agent/policy.ts:157-158`). `summarize` for any generic-server tool renders `Run <action>` with no parameters - the exact 16.3 surface, empty. Fix: default branch renders `showPayload(JSON.stringify(input))` capped (~300 chars). Test: an unknown action's summary contains its params with control chars visible.
- **B1.7 `showPayload` misses invisible characters** (`agent/policy.ts:110-113`). Only `\r\n\t` are escaped; zero-width and RTL-override chars can visually mask an approval payload. Fix: escape all Unicode Cf/Cc characters. Test: a payload with U+202E renders escaped.

**Exit:** the spoof shapes from the review classify gated on both brains; an unattended run provably cannot open a browser, write memory, or reach a promoted networked server; a silent clip cannot approve; all prior tests still green.

## Phase B2 - Daily use: the resident stops dying under the user's hands  ✅ DONE (2026-07-20)

Goal: normal interaction (typing in settings, correcting a transcript) never kills an in-flight turn or wipes conversation memory.

**Status:** all of B2.1-B2.9 landed. Suite green: 179/179 TS tests (was 176, +3 regression tests for B2.4), 15/15 Rust (was 14, +1 for B2.1/B2.2), `npm run typecheck` (all 6 tsconfigs), `eslint .` (zero warnings), `cargo clippy --all-targets` (clean), production `vite build` (chunks stay code-split). The resident-kill choke point now defers while busy (`AgentSession::request_respawn`, applied at `settings.rs` save + `write_memory`/`write_lessons`); the deferred respawn lands in the reader's `final` handler (`apply_pending_respawn`) or at the next `ensure_resident` spawn.

- **B2.1 Deferred-while-busy resident shutdown** ✅ - `AgentSession` gained a `respawn_pending` flag and `request_respawn()`: busy -> mark, idle -> shut down now. `settings.rs:save_settings`, `write_memory`, and `write_lessons` route through it; `ensure_resident` applies a pending respawn at the spawn boundary, the reader's `final` applies it when the last turn drains. `shutdown()` stays unconditional for the watchdog.
- **B2.2 Review-card correction kills the command being sent** ✅ - `learnCorrections` moved to AFTER `runAgent` resolves in `accept`, so persisting the grown dictionary (which now defers the respawn via B2.1) can't kill the in-flight turn. Rust regression test proves a config change while a turn is registered spares the child and applies once idle.
- **B2.3 Every keystroke in Settings kills the resident + churns the mic** ✅ - `SettingsPanel.update` debounces the save ~800ms (flushes any pending write on unmount); `VoicePanel.refreshSettings` keeps the prior `wake`/`handsFree` object identity when the value is unchanged (`sameWake`/`sameHandsFree`) so their effects don't re-arm the mic per save.
- **B2.4 `KEY=value` textareas eat keystrokes** ✅ - new `MapTextarea` (raw-string local state, parse on blur) replaces the four re-derived-each-render textareas (dictionary, snippets, MCP env, headers); pure parse/format split into `lib/kv-map.ts`. 3 regression tests.
- **B2.5 Error phase dead-ends hands-free** ✅ - an `error` phase auto-expires to `idle` after 4s (`ERROR_EXPIRE_MS`), re-arming wake.
- **B2.6 Dictation-on at rest is invisible and unreachable** ✅ - `dictation` folded into the widget's `active` signal so the card (with its off-toggle + status) stays visible while latched-and-idle.
- **B2.7 Widget ignores `agent://reset`** ✅ - `VoicePanel` listens for `agent://reset` and runs its `cancel` teardown, skipping only its own `thinking` phase (the Phase 11.2 idle-reset, which would otherwise kill the just-dispatched turn).
- **B2.8 Mid-turn `need-key` clobber** ✅ - `refreshSettings` only enters `need-key` from `idle`/`error`/`need-key`, never from a live review/thinking/speaking phase.
- **B2.9 Spoken-approval effect ignores `voiceBlocked`** ✅ - the spoken-approval effect bails under a voice-off mode (added to guard + deps) so it can't silently auto-deny the gate.

<details><summary>Original findings</summary>

- **B2.1 Deferred-while-busy resident shutdown** (`src-tauri/src/settings.rs:57-70`, `agent_runner.rs:559-563`). `save_settings` unconditionally kills the resident. Fix at the choke point: if `AgentSession::is_busy`, mark respawn-pending instead of killing; apply the shutdown lazily when the turn completes (or on next-turn spawn, the mechanism that already exists). This single fix covers both B2.2 and B2.3's kill paths.
- **B2.2 Review-card correction kills the very command being sent** (`src/voice/VoicePanel.tsx:255` -> `save_settings`). `learnCorrections` races the just-dispatched turn and typically kills it ("The agent stopped unexpectedly"), the exact opposite of the code comment. Fix: with B2.1 in place, additionally delay the save until `agent://final` for that turn. Test: a Rust test that `save_settings` while busy does not kill the child.
- **B2.3 Every keystroke in Settings kills the resident + churns the mic** (`src/settings/SettingsPanel.tsx:94-97`; wake effect re-arms per `settings://changed`). Fix: debounce persistence (~800ms after last change); in `VoicePanel`, compare relevant settings by value before tearing down/re-arming wake and hands-free effects.
- **B2.4 `KEY=value` textareas eat keystrokes** (`SettingsPanel.tsx:858-872`; dictionary :601, snippets :618, MCP env :991, headers :1013). The controlled value is re-derived from the parsed map each render, so the first char of a new line vanishes - hand-typing an entry is impossible. Fix: keep the raw string in local state, parse on blur/save. Test: a component-level parse round-trip keeping incomplete lines.
- **B2.5 Error phase dead-ends hands-free** (`VoicePanel.tsx:442, 467`). One "I didn't hear a command" permanently disables wake until the orb is clicked. Fix: auto-expire `error` -> `idle` after ~4s (same pattern as `dictated` at :389).
- **B2.6 Dictation-on at rest is invisible and unreachable** (`VoicePanel.tsx:548`, `styles.css:96-98`, orb disabled :700). With dictation latched and idle the card is hidden and the orb disabled - no indicator, no off-switch, contradicting 15.4's "visible indicator throughout". Fix: fold `dictation` into the widget's `active` signal.
- **B2.7 Widget ignores `agent://reset`** - a "New conversation" from the app face resets the resident while the widget keeps speaking/capturing a dead turn. Fix: `VoicePanel` listens and runs its existing teardown.
- **B2.8 Mid-turn `need-key` clobber** (`VoicePanel.tsx:124`). A settings change to an OpenAI stack discards a live review card / speaking state. Fix: only enter `need-key` from `idle`/`error`.
- **B2.9 Spoken-approval effect ignores `voiceBlocked`** (`VoicePanel.tsx:501`). Under a blocked mode it silently auto-denies the gate ~8s in, racing the user's click. Fix: bail unless voice is actually available; leave the card to the click path.

</details>

**Exit:** type a full schedule + dictionary entry by hand in Settings while a turn runs - the turn completes and the entry persists; correct a transcript and Send - the corrected command executes; a hands-free error self-recovers; dictation mode always shows its state.

## Phase B3 - Autonomy & missions: unattended paths are correct, not just safe  ✅ DONE (2026-07-20)

**Status:** all of B3.1-B3.9 landed. Suite green: 183/183 TS tests (was 179, +4 regression tests for B3.5/B3.9), 17/17 Rust (was 15, +2 for B3.1/B3.2), `npm run typecheck` (all 6 tsconfigs), `eslint .` (zero warnings), `cargo clippy --all-targets` (clean), production `vite build` (chunks stay code-split). The watchdog is now an idle-silence window reset by any reader event; `run_agent` returns a structured `{text, isError}` so a failed mission task fails; the trigger baseline no longer advances when a change is deferred; and memory/lessons ride the same forge-stripped fence as trigger payloads.

- **B3.1 File-trigger events lost while busy** ✅ - the mtime baseline logic moved into a pure `trigger_action(prev, modified, busy)` reducer (`scheduler.rs`): a change while busy is `Ignore`d WITHOUT advancing the baseline, and the baseline advances only after a run actually dispatches, so a change during a user turn re-fires on the next idle tick. Rust test `defers_a_change_while_busy_without_losing_it`.
- **B3.2 Watchdog kills healthy long turns** ✅ - `WATCHDOG` is now an idle-silence window, not a wall-clock cap. A new `TurnMsg::Activity` ping is sent on every `text`/`tool`/`result`/`approval` reader event; `await_turn(rx, idle)` resets the deadline on each, returning only on `Done` or true silence. Rust test `await_turn_extends_on_activity_but_times_out_on_silence` (activity over 240ms survives a 120ms idle window; real silence still times out).
- **B3.3 Scheduler busy-check races the user** ✅ - `run_unattended` now calls `ensure_resident` FIRST (the multi-second spawn), THEN re-checks busy atomically with claiming the turn slot; if a user/mission turn slipped in it returns `Ok(None)` (deferred). `fire` returns whether it dispatched, and the scheduler advances `fired`/baseline only on a real dispatch, so a deferred run retries next tick.
- **B3.4 Failed mission tasks count as done** ✅ - `run_agent` now returns a structured `TurnReply { text, isError }` (voice still speaks the text; the flag rides alongside). `runMission` passes `!isError` to `advanceMission`, so a brain-flagged task shows ✕ and the mission finishes `failed`.
- **B3.5 Mission Stop neither cancels nor closes** ✅ - Stop now calls `cancelAgent(activeTurnRef.current)` to halt token spend and `stopMission(board)` (new pure reducer) to mark the active task failed + close the mission `failed`, so the Clear button renders. Regression tests for `stopMission`.
- **B3.6 Mission decomposition runs in the existing conversation** ✅ - `runMission` calls `newConversation()` before the decomposition turn, so a prior chat can't contaminate the plan.
- **B3.7 Turn-counter collision on webview reload** ✅ - counters seed from monotonic per-load bases (`interactiveTurnBase()` / `missionTurnBase()` in `session.ts`, ms since a fixed epoch), kept ordered below the Rust unattended space (2^40), so a reload never reuses a number still registered in the shared `turns` map.
- **B3.8 Unbounded trigger-file read** ✅ - `read_trigger_head` reads only the first 64 KiB of a watched file (comfortably above the TS 4000-char cap), so a multi-GB log can't balloon memory.
- **B3.9 Fence memory/lessons injection** ✅ - the fence-strip is extracted as `fenceUntrusted` in `schedules.ts` (uncapped; `quarantine` layers the cap on top for trigger payloads). `withMemory` and `withRecalledLessons` now wrap injected file content in it, so a poisoned entry is read as data, never obeyed. Regression tests for `fenceUntrusted`.

<details><summary>Original findings</summary>

- **B3.1 File-trigger events lost while busy** (`src-tauri/src/scheduler.rs:195-201`). The mtime baseline updates *before* the busy-check `continue`, so a change during a user turn never fires. Fix: don't advance the baseline when deferring. Rust test: change-while-busy fires next tick.
- **B3.2 Watchdog kills healthy long turns** (`agent_runner.rs:35, 642-660, 711-725`). Fixed 180s wall-clock per turn; one 120s approval plus real work can't fit, and the timeout path `shutdown()`s the resident, destroying conversation memory. Fix: event-driven deadline - any reader event for the turn (`text`/`tool`/`approval`) resets it. Rust test: events extend the deadline; true silence still times out.
- **B3.3 Scheduler busy-check races the user** (`scheduler.rs:181-183` vs `agent_runner.rs:705`). `ensure_resident` can take 8s+ (spawn + backoff) between the busy check and the dispatch; a user turn arriving meanwhile is preempted (serve.ts cancels the active turn). Fix: re-check `is_busy` immediately before `write_request`; defer if busy.
- **B3.4 Failed mission tasks count as done** (`agent_runner.rs:525-529`, `src/app/MissionBoard.tsx:41-45`). `final` with `isError:true` still resolves `Ok`, so `advanceMission(mission, true)` marks the task done and the "finishes failed" path never fires. Fix: surface `isError` through the turn result (structured Ok or Err) and pass the real success flag to `advanceMission`.
- **B3.5 Mission Stop neither cancels nor closes** (`MissionBoard.tsx:91, 38, 127`). Stop only flips a ref: the in-flight run keeps spending tokens (the 11.3 problem reintroduced) and the board stays "active" forever with no Clear button. Fix: Stop calls `cancelAgent(turn)` and marks the board stopped/failed so Clear renders.
- **B3.6 Mission decomposition runs in the existing conversation** (`MissionBoard.tsx`). Leftover context contaminates the plan. Fix: `newConversation()` before the decomposition turn (tasks already get fresh sessions).
- **B3.7 Turn-counter collision on webview reload** (`MissionBoard.tsx:19`, `VoicePanel.tsx:66`). Counters reset on reload; a reused number replaces the live `Sender` in the shared `turns` map and the orphan path `shutdown()`s the resident. Fix: seed counters from a monotonic source (e.g. ms-since-epoch base per window load).
- **B3.8 Unbounded trigger-file read** (`scheduler.rs:203`). `read_to_string` of a multi-GB log balloons memory before the TS 4000-char cap. Fix: read only the first N KB in Rust.
- **B3.9 Fence memory/lessons injection** (`agent/prompt.ts:25-33`, `serve.ts:83-88`). File contents (which the model itself wrote) are injected into prompts unfenced - persistent-injection defense-in-depth is one reuse of `frameUnattended`'s fence-strip away. Fix: wrap `withMemory`/`withRecalledLessons` content in the same forge-stripped fence.

</details>

**Exit:** a file change during a user turn fires on the next tick; a 4-minute turn with one approval completes; a failed mission task shows ✕ and the mission finishes `failed`; Stop provably stops token spend.

## Phase B4 - Hygiene & polish  ✅ DONE (2026-07-20)

**Status:** all of B4.1-B4.11 landed. Suite green: 187/187 TS tests (was 183, +4 regression tests: `trimTurnHistory` x2, transcript `$`-injection, `WakeModel.feed` serialization), 17/17 Rust, `npm run typecheck` (all 6 tsconfigs), `eslint .` (zero warnings), `cargo clippy --all-targets` (clean), production `vite build` (chunks stay code-split). The second, divergent gate implementation is gone from the tree; the node memory/lessons writers are atomic; `ensure_resident` holds the resident lock across check+spawn; the OpenAI brain rolls back and trims against the array captured at turn start; `audit.jsonl` rotates; and the doc claims match the post-fix code.

- **B4.1 Delete `agent/run-once.ts`** ✅ - removed; nothing imported it (only comments/graphify referenced it). The two stale comments that pointed at it as a *live* path (`settings.rs`) now point at `serve.ts`.
- **B4.2 Atomic writes in node MCP servers** ✅ - `mcp/memory/server.ts` and `mcp/lessons/server.ts` now write to a `.tmp` then `rename`, mirroring the Rust side, so a crash mid-write can't truncate the file.
- **B4.3 `ensure_resident` double-spawn race** ✅ - the resident lock is now held across the try_wait check AND the spawn, so two callers (an interactive turn and a scheduled/mission run) can't both spawn and orphan a child.
- **B4.4 OpenAI-brain `reset()` mid-turn corrupts `#messages`** ✅ - `run()` captures `const history = this.#messages` at turn start and rolls back / appends / trims against that reference; a mid-turn `reset()` swaps the field to a fresh array without the in-flight turn corrupting it.
- **B4.5 Cap/rotate `audit.jsonl` + trim OpenAI-brain history** ✅ - `audit.jsonl` rolls to `audit.jsonl.1` past 5 MiB; a new pure `trimTurnHistory` caps retained `#messages` at 60 messages, cutting only at a `user` turn boundary so a tool result never loses its assistant tool_call.
- **B4.6 Wake fallback respects the user's STT choice** ✅ - `startWakeListener` takes the user's `stt` choice and the burst fallback transcribes with it, so a local-STT user never has the wake fallback silently hit cloud Whisper; the cloud burst path is already gated by `allowCloudFallback`/`voiceBlocked`.
- **B4.7 Serialize `WakeModel.feed`** ✅ - `feed` now promise-chains each per-frame call (`#pending`), so the fire-and-forget caller can't overlap inference and clobber the streaming buffers. Regression test proves no concurrent mel runs.
- **B4.8 Mic-stream leaks** ✅ - `startCapture` stops the stream if `MediaRecorder` construction throws; a PTT release that lands while the capture is still opening is flagged (`releaseDuringSetup`) and honoured the instant the mic is ready, so a quick tap no longer sits recording to the 15s cap.
- **B4.9 `applyMap` `$`-pattern injection** ✅ - `applyMap` uses a function replacement, so `$&`/`$1` in a user's dictionary/snippet value insert literally. Regression test.
- **B4.10 Small UI states** ✅ - orb press in `review` now re-records; `decide()` restores the approval card if `resolve_approval` rejects; `useMission` ignores a slow seed read once a live event has landed; `SettingsPanel` reloads on `settings://changed` while no local edit is pending (no stale-save over a widget-learned correction); KeyRow Clear is disabled until key presence is confirmed; and the backchannel "On it." is suppressed while an approval is pending (never over a spoken repeat-back).
- **B4.11 Doc corrections in improvement-4.md** ✅ - 19.2 marked as dormant dead code (nothing populates `toolsetIds`); the phase-12 headless-Chromium check reworded as an uncommitted one-off; and the 13.2 (B1.1), 16.3 (B1.6/B1.7), 18.2 (B1.3), 19.1 (B3.7) and 15.2 (test count) claims updated to post-fix reality.

<details><summary>Original findings</summary>

- **B4.1 Delete `agent/run-once.ts`** - dead code carrying a second, divergent gate implementation with no unattended branch; pure drift risk.
- **B4.2 Atomic writes in node MCP servers** (`mcp/memory/server.ts:62-65`, `mcp/lessons/server.ts:67-70`) - temp+rename, mirroring the Rust side.
- **B4.3 `ensure_resident` double-spawn race** (`agent_runner.rs:377-407`) - hold the lock across check+spawn or re-check after re-acquire.
- **B4.4 OpenAI-brain `reset()` mid-turn corrupts `#messages`** (`openai-brain.ts:137, 152-154`) - rollback against the array captured at turn start, not the field.
- **B4.5 Cap/rotate `audit.jsonl`** (`agent_runner.rs:41-60`) and trim OpenAI-brain history growth (`openai-brain.ts:83`).
- **B4.6 Wake fallback respects the user's STT choice** (`src/lib/wake.ts:185`) and skips cloud retry when Rust will refuse it (`VoicePanel.tsx:449`).
- **B4.7 Serialize `WakeModel.feed`** (`src/lib/wakeword.ts:198-203`) - promise-chain the per-frame calls so slow inference can't clobber the accumulator.
- **B4.8 Mic-stream leaks**: stop the stream if `MediaRecorder` construction throws (`voice-capture.ts:196`); handle PTT release during async capture setup (quick-tap currently leaves the mic open up to 15s).
- **B4.9 `applyMap` `$`-pattern injection** (`src/lib/transcript.ts:49`) - use a function replacement so `$&`/`$1` in dictionary values are literal.
- **B4.10 Small UI states**: orb inert in `review` phase (make press = re-record); `decide()` optimistically clears the approval card even if `resolve_approval` rejects; `useMission` seed race (event before file read resolves); SettingsPanel doesn't reload on `settings://changed` (stale-save overwrites a widget-learned correction); KeyRow Clear enabled while presence unknown; backchannel "On it." can overlap the spoken repeat-back.
- **B4.11 Doc corrections in improvement-4.md**: 19.2 toolset scoping is dead code (nothing populates `toolsetIds`); the 12-follow-up headless-Chromium harness is not in the repo (either commit it under `scripts/` or reword the claim); update the 13.2 / 18.2 / 15.2 / 15.4 / 16.3 / 19.1 claims to match post-fix reality.

</details>

**Exit:** full suite green; no dead gate code in the tree; every doc claim reproducible from the checkout.

---

## Verification bar (every phase)

`npx vitest run`, `npx tsc --noEmit` (all tsconfigs), `npx eslint .`, `cargo test` + `cargo clippy --all-targets` in src-tauri, production `npx vite build` (chunks stay code-split) - plus new regression tests named per finding above. Live-mic / GUI checks stay the manual pass, same bar as improvement-4.md.
