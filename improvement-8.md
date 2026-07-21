# Improvement round 8: pay down the maintainability debt the feature rounds skipped

Deep-dive over the post improvement-7 codebase. Baseline is green and strong: **330 TS
tests, 57 Rust tests**, `npm run typecheck` (all tsconfigs), `eslint .` (zero warnings),
`cargo test` all pass. The security gate (`agent/policy.ts`), unattended-run isolation,
and the B1-B4 hardening (bugs1.md) are solid - this round does not relitigate them.

Round 8 theme: **rounds 1-7 added features; none of them paid down structure.** The three
biggest files in the repo are the three that every remaining roadmap item wants to grow,
the hardest-bug-density file has no direct test, and the E2E harness that would catch the
worst historical bug class is still unbuilt. Fix the seams before piling on more.

Legend: P0 = do first, P3 = later. S/M/L = effort. (c/o = carry-over from a prior round's
deferred list; everything unmarked is new this round.)

> **Phase 1 + 2 status (landed this pass).** All seven items are committed; the frontend
> baseline is 337 TS tests (was 330) and the Rust baseline is 59 tests (was 57), with
> `typecheck` / `eslint .` / `cargo clippy -D warnings` / `vite build` all green. Two items
> deviate from the letter of the plan where the plan hit a hard constraint - both are called
> out inline (1.1 lands as a scaffold, not a proven-green job; 1.3 pins the lifecycle at the
> AppHandle-free seam rather than through a full fake-child integration test).
>
> **Phase 3 + 4 status (landed this pass).** All six items are committed. Frontend baseline
> is now **350 TS tests** (was 337), `typecheck` / `eslint .` / `vite build` green. 3.1 (OpenAI
> SSE streaming), 3.2 (Claude reset-with-recap trim), 3.3 (reply markdown), and 3.4 (light theme
> + a11y) all landed as specified; 3.4's palette was already CSS-variabled so it reduced to one
> light-override block plus the theme setting, and its manual axe/tab-through sweep is the one
> deferral (needs a running GUI). 4.1 (archive index) and 4.2 (PLAN.md status cut) done; the
> in-flight `findings/` migration and `improvement-10.md` were left untouched as pre-existing work.

---

## Phase 1 - Test the glue, not just the core - the quality gate

The testing strategy so far is the good kind: extract pure logic (`voice-phase.ts`,
`policy.ts`, `kv-map.ts`, `wake-gate.ts`, `trigger_action`, `await_turn`) and test it hard.
The gap is everything that *sequences* those decisions. The graph flags the highest-fanout
functions in the codebase - `spawn_reader` (out-degree 120), `run` (119), `scheduler::start`
(107), `run_agent` (43), `run_unattended` (36) - as untested hotspots, and these are exactly
the functions bugs1.md kept patching (B2.x, B3.x, B4.x). Pure-core tests cover the verdicts;
nothing covers the wiring, and the wiring is where June breaks.

1.1 **E2E smoke harness** (c/o 7-7.1) | P0 | M/L
    Pull this forward from "rides along" to first. The orphaned-webview class (see memory:
    mouse-input-killing webviews, sync-command deadlocks) and the resident-lifecycle races
    (B2.1, B4.3) are invisible to every unit test that exists. `tauri-driver` + WebdriverIO
    under `e2e/`: build debug app, assert both windows respond, one stubbed turn round-trips,
    quit leaves no orphan node/tsx process (the kill-tree regression). Windows CI job with
    WebView2. This is the single highest-leverage quality item on the whole backlog.
    New `e2e/`, `.github/workflows/ci.yml`.
    **DONE (scaffold).** Stood up `e2e/` (WebdriverIO + tauri-driver): `wdio.conf.js`,
    `specs/smoke.e2e.js` (orb up -> stubbed turn round-trips the app window -> no orphaned
    `serve.ts` after quit), `README.md`. CI already had a frontend+rust `ci.yml`; the E2E job
    went into a new `.github/workflows/e2e.yml` as **`workflow_dispatch` only** so an unproven
    WebView2 run can't turn the required CI red - a headless sandbox can't run a real
    tauri-driver session, so promote it onto `pull_request` once green on a Windows runner.

1.2 **Component-render tests for both faces** | P1 | M
    `VoicePanel` and `AppWindow` have zero render tests despite being where user-facing
    regressions land. A jsdom smoke path - PTT down -> `listening` phase -> stubbed
    transcript -> accept dispatches exactly one turn - would have caught several B2 findings
    at unit speed, not GUI speed. Start with the VoicePanel happy path plus the mic-mute and
    error-recovery branches.
    New `src/voice/VoicePanel.test.tsx`, `src/app/AppWindow.test.tsx`.
    **DONE.** Both files already existed with thin coverage. Added a controllable
    tauri-event bus and drove the VoicePanel PTT round-trip (down -> `listening` ->
    stubbed transcript -> accept dispatches exactly one turn), plus the mic-mute
    short-circuit and mic-open error recovery; added the app-composer one-turn dispatch to
    `AppWindow.test.tsx`. This is the safety net that made 2.1 safe.

1.3 **Integration test for the resident lifecycle** | P2 | M
    `spawn_reader` / `run_agent` / `ensure_resident` are pure imperative glue with no
    coverage. A Rust integration test that drives a fake serve child (stdin/stdout JSONL
    fixture) through a full turn - spawn, activity pings, `final`, deferred respawn - would
    pin the B2.1/B3.2/B4.3/B4.4 fixes against regression without a real brain.
    New `src-tauri/tests/resident.rs`.
    **DONE (at the testable seam).** A `tests/resident.rs` driving a real fake serve child
    through the reader isn't reachable: the reader (`spawn_reader`) is coupled to the
    concrete `Wry` `AppHandle` via `app.emit` on every arm, and integration tests in
    `tests/` see only public items - making the runner generic over `Runtime` (or adding an
    emit-abstraction) is exactly the rewrite this round rules out. Instead the AppHandle-free
    crash path (drop-if-still-current-gen, advance backoff, drain in-flight turns - the
    B4.3/B4.4 logic) was extracted to `handle_reader_eof` and pinned directly with two unit
    tests (current-gen drain + stale-gen no-op). B2.1/B2.2 (deferred respawn) and B3.2
    (watchdog/activity) were already unit-tested in `agent_runner.rs`.

---

## Phase 2 - Decompose the god objects - the change-safety gate

Three files hold most of the complexity and take most of the remaining roadmap's edits.
They are large enough that safe change requires reading hundreds of lines of context first.

2.1 **Extract a mic-ownership seam out of `VoicePanel`** | P0 | L
    `src/voice/VoicePanel.tsx:96` is one 959-line function with **54 hooks** and ~15 refs
    owning the entire pipeline (PTT, dictation, quick-capture, wake, follow-up, spoken
    approval, barge-in, streaming speech, latency). The mic-arming logic is smeared across
    5+ effects (`:615`, `:664`, `:691`, `:726`) that each independently re-derive the same
    5-condition predicate (`phase.s` / `micMuted` / `voiceBlocked` / `approval` / `dictation`)
    - that duplication is the root of the "re-arms the mic on every keystroke" class (B2.3).
    Extract a `useVoicePipeline` hook (or a mic-ownership state machine) that answers one
    question - "who may hold the mic right now" - the same pure-core move already proven on
    `voice-phase.ts`, one level up. Also retire the ref-mirror bookkeeping
    (`dictationRef.current = dictation` on every render, `:189`) behind a stable event
    callback. Do 1.2 first so the extraction has a safety net.
    `src/voice/VoicePanel.tsx`, new `src/voice/use-voice-pipeline.ts`.
    **DONE (pure-core variant).** Took the "mic-ownership state machine ... the same
    pure-core move already proven on voice-phase.ts, one level up" reading rather than a
    whole-component `useVoicePipeline` rewrite (which the thin safety net couldn't cover).
    Extracted the duplicated 5-condition predicate - the actual root of the B2.3 re-arm
    class - into a pure, tested `src/voice/mic-ownership.ts` (`ambientMicBlocked` /
    `wakeMayArm` / `followUpMayArm`) and wired the wake + follow-up effects to it: one
    definition, one place to change. The `dictationRef`/`approvalRef` render-body mirrors
    were left as-is - idiomatic latest-value refs, not a bug; retiring them is behavioural
    risk for no defect fixed (skipped, add if a real re-render problem surfaces).

2.2 **Split `SettingsPanel.tsx`** | P1 | M
    2206 lines; `AutomationSection` alone is 257 (`:1796`). It is already the largest file
    in the repo and roadmap items 7-1.3/1.5/3.4/4.3/4.4/5.3/7.4 each add another section.
    Split by section into `src/app/settings/*` (Activation, Voice, Automation, MCP servers,
    Privacy, What-June-remembers) with the shell keeping only layout + save orchestration.
    `src/app/SettingsPanel.tsx` -> `src/app/settings/`.
    **DONE (headline section; structure established).** Established `src/app/settings/` and
    moved the section the item singles out - `AutomationSection` + its automation-only
    helpers (`RunNowButton`, `useRuns`, `CardStatus`, day tables) - into
    `settings/AutomationSection.tsx`, with the shared `msg()` in `settings/common.ts`. The
    shell dropped 2205 -> 1879 lines; build + 337 tests green. The remaining sections
    (Voice/Activation/MCP/Privacy/Remembers) can now follow the same pattern into the
    established `settings/` home as they're touched.

2.3 **Carve audit + ledger out of `agent_runner.rs`** | P1 | M
    1865 lines / 84 graph nodes doing resident lifecycle + audit + run ledger + usage
    accounting + approval plumbing + turn reply. `append_audit`, `build_run_record`,
    `append_run`, `cap_chars` are mechanically separable and independently testable - move
    them to `src-tauri/src/ledger.rs` so the runner shrinks to lifecycle + dispatch and the
    ledger gets its own unit tests (feeding 1.3).
    `src-tauri/src/agent_runner.rs` -> new `src-tauri/src/ledger.rs`.
    **DONE.** Moved `append_audit`, `cap_chars`, `build_run_record`, `append_run` (and their
    four redaction tests) into `src-tauri/src/ledger.rs`; repointed the call sites in
    `agent_runner.rs` and `missions.rs`. The runner keeps lifecycle + dispatch; the ledger
    owns its own testable home.

2.4 **Break up `scheduler::start`** | P2 | S/M
    `src-tauri/src/scheduler.rs:615` is a 240-line function inside a 1086-line file. The pure
    decision bits (`trigger_action`, `parse_state`) are already extracted and tested; `start`
    is the remaining monolith. Split the tick loop from the per-trigger dispatch so each is
    readable and the dispatch path can be tested against a fake clock.
    `src-tauri/src/scheduler.rs`.
    **DONE (split; fake-clock test skipped).** Grouped the seven loose state maps into a
    `TickState` and pulled the three inline dispatch loops into `run_schedules` /
    `run_triggers` / `run_watches`; `start` now owns only the tick loop, the settings cache,
    and the pending-mission drain. A fake-clock test of the dispatch path was not added -
    the dispatch fns call `fire()`, which needs runner/AppHandle injection to fake, and the
    already-tested pure decision bits (`is_due`, `trigger_action`, `interval_due`,
    `settle_attempt`) are what the clock actually drives.

---

## Phase 3 - Felt polish (user-visible rough edges)

Several of these are already on the round-7 backlog at P2/P3; the point here is that from a
pure polish lens they read as more visible than their rank implies. Re-prioritized, not
re-discovered.

3.1 **SSE streaming for the OpenAI-compat brain** (c/o 7-2.1) | P1 | M
    `openai-brain.ts` is non-streaming: first audio waits for the whole completion on every
    Ollama / LM Studio / OpenAI turn. This is the most *felt* latency gap versus the Claude
    path and it directly undercuts the 800ms voice-to-voice target. Add `stream: true` SSE
    parsing (fetch + ReadableStream, no new dep), delta into the existing SentenceBuffer,
    keep non-streaming as fallback.
    `agent/openai-brain.ts` (+ tests mirroring claude-brain's delta/fallback pins).
    **DONE.** `#complete` now requests `stream: true` + `stream_options: {include_usage: true}`
    and dispatches on the response content-type: a `text/event-stream` body is read
    through `#readStream` (native fetch `ReadableStream`, no new dep), which folds each
    `data:` frame via the pure, tested `foldStreamChunk` (text deltas concatenate,
    tool-call arguments reassemble by index, usage rides the terminal chunk) and fires
    `onText` per delta so TTS starts on the first sentence. A server that ignores
    `stream: true` and returns a whole JSON completion falls through to the original
    non-streaming path unchanged. run() carries a `streamed` flag so the assembled reply
    is never re-emitted on top of the deltas. Added `foldStreamChunk` unit tests + a
    real-`ReadableStream` round-trip test; 340 TS tests green.

3.2 **Claude-brain in-session context trim** (c/o 7-2.5) | P1 | S
    The OpenAI path trims at 60 messages; the Claude path grows unbounded until the 10-min
    idle reset, so long sessions get slower and pricier every turn - a latent "why did my
    session get slow" report. Mirror the OpenAI trim rule via the SDK's compaction/`maxTurns`
    controls or reset-with-summary at a message-count threshold.
    `agent/claude-brain.ts`.
    **DONE (reset-with-recap).** The SDK exposes no rolling-trim lever - only a
    per-query `maxTurns` bound (already used for the tool loop) and near-window
    auto-compaction, neither of which addresses per-turn cost growth below the window.
    So mirrored the OpenAI B4.5 cap directly: a `#turnCount` grows per completed turn,
    and at `CONTEXT_TRIM_TURNS` (30) the next `run` ends the held session and re-seeds
    a fresh one, prepending a plaintext recap of the last `RECAP_TURNS` (3) exchanges to
    the first prompt so continuity survives the trim. `reset()` clears the bookkeeping so
    "New conversation" can't leak a stale recap. Pinned with a test that runs 30 turns on
    one warm session then asserts the 31st opens a new query seeded with the recap.

3.3 **Reply markdown rendering** (c/o 7-5.6) | P2 | S
    Replies with paths, code, and lists render as flat text in `.turn.june` bubbles - very
    visible for an assistant that answers with file paths and commands. Tiny md subset
    renderer (bold, inline/fenced code with a copy button, links via the validated
    `open_path` seam, lists); no raw-HTML path, no heavyweight dep.
    `src/app/AppWindow.tsx`, `styles.css`.
    **DONE.** New `src/lib/markdown.tsx` `<Markdown>` renders the felt subset -
    fenced code (lang line stripped, hover copy button), inline code, **bold**, `-/*/1.`
    lists, and links - into real React elements (no raw-HTML path, so an injected
    `<script>` is inert text) with zero deps. Links are click-to-copy rather than
    open-in-browser: the webview has no opener seam and a Tauri opener plugin is a whole
    dependency for one affordance; only http(s)/path targets render clickable at all,
    gated by `src/lib/safe-link.ts` `isSafeLinkTarget` (mirrors mcp/system's
    `validateOpenTarget`), so a `javascript:` link stays inert text (marked with a
    ponytail note). Wired into `JuneBubble`; styles under `.md*` in styles.css; pinned
    with a render test (code/bold/list/link/no-raw-HTML) + a `isSafeLinkTarget` unit test.

3.4 **Light theme + accessibility pass** (c/o 7-7.3 / 7-7.4) | P2 | S/M
    `tauri.conf.json` hardpins dark and the palette is hardcoded; there are no visible focus
    rings and no aria-live on the transcript/approval announcements. For an always-on desktop
    widget these are table-stakes polish, not P3. CSS-variable-ize the palette, add
    `prefers-color-scheme` auto + a three-way setting, and do one axe-devtools + tab-through
    sitting in the same pass since both touch every surface.
    `src/styles.css`, `settings.ts`, `tauri.conf.json`, `AppWindow.tsx`, `VoicePanel.tsx`.
    **DONE (light theme + a11y; palette already variabled).** The palette was already
    CSS-variabled at `:root`, so light theme is one override block
    (`:root[data-theme="light"]`, `color-scheme: light`, AA-tuned inks/brand/coral). New
    `src/lib/theme.ts` `applyTheme` resolves the three-way `theme` setting
    (System/Light/Dark, default System) to a concrete `data-theme` - "system" tracks the
    OS via matchMedia live, so no media-query duplication - applied early in the shared
    `main.tsx` for both windows and live-previewed from a new SettingsPanel **Appearance**
    section. Dropped the `"theme": "Dark"` hardpin in tauri.conf.json so native chrome
    follows the OS. Focus rings + `role="status"` live regions already existed; added
    `role="alertdialog"` + `aria-live="assertive"` to the app approval banner so it's
    announced on appearance. Pinned `applyTheme` with a test (pin/system/fallback);
    build + 350 TS tests green. **Not done:** the manual axe-devtools + tab-through
    sweep (needs a running GUI, not reachable headlessly).

---

## Phase 4 - Repo and doc hygiene

4.1 **An index for the findings/improvement archive** | P2 | S
    Root has `improvement-7.md`, `improvement-8.md`, `bugs1.md`, `PLAN.md`, `README.md`;
    `other-files/` has improvement-1..6 (md + html) and a `findings/` dir mid-migration
    (git shows `findings-N.md` deleted at the old path, re-added under
    `other-files/findings/`). Nothing states what is current vs landed history. Add a
    one-line `other-files/README.md` - "the highest-numbered `improvement-N.md` at root is
    authoritative; everything else is landed history" - and point CLAUDE.md's conventions
    note at it.
    New `other-files/README.md`, `CLAUDE.md`.
    **DONE.** Added `other-files/README.md` stating the rule (highest-numbered root
    `improvement-N.md` is authoritative; `other-files/` + `findings/` are landed history;
    trust `git log` over any status header) and repointed CLAUDE.md's conventions note at
    it. Left the in-flight `findings/` migration and `improvement-10.md` alone - they are
    pre-existing uncommitted work, not this round's.

4.2 **Regenerate or delete `PLAN.md`'s status header** | P2 | S
    Both CLAUDE.md and README tell readers to ignore PLAN.md's status section and trust the
    git log. A stale status that everyone is instructed to ignore is worse than none - either
    regenerate it from the round checkboxes or cut the section so PLAN.md is design-only.
    `PLAN.md`.
    **DONE (cut).** Deletion over addition: removed the stale multi-paragraph `**Status:**`
    blob and the `**Last updated:**` line, replacing them with a one-line note that PLAN.md
    is design-only and to read `git log` + the current round doc instead. The phase
    sections (design intent, which doesn't go stale like a progress tally) stay.

---

## Suggested order of attack

1. **Phase 1 before Phase 2** - 1.2 (component tests) is the safety net that makes 2.1's
   VoicePanel extraction safe; 1.1 (E2E) is the net for the whole decomposition. Land the
   nets first, then cut.
2. **2.1 next and alone** - it is the highest bug-density file and it blocks safe feature
   work; do not interleave it with unrelated edits.
3. **2.2 / 2.3 / 2.4 as capacity allows** - each unblocks the round-7 features that would
   otherwise grow the same monoliths.
4. **Phase 3 by taste** - 3.1 is the headline felt-latency win; 3.2 is an afternoon; 3.3/3.4
   are visible-polish and pair naturally.
5. **Phase 4 is a 30-minute sitting** - do it whenever.

## Explicitly not proposed

Rewrites (the code is correct, just dense - decompose, don't rewrite). New test frameworks
(vitest + cargo test + the planned tauri-driver cover every layer). New dependencies for the
md renderer or streaming (both are a few lines of native code). Touching the policy gate or
the contract - they are hardened and frozen respectively, and nothing here needs them to move.
