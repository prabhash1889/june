# Improvement round 5: two deep dives (app/features + UI/UX), merged plan

Date: 2026-07-20. Sources: one deep-dive agent on architecture/features (including web research
on BridgeAgent by BridgeMind), one on UI/UX. Every finding verified in source with file:line
references. Sizes: S < 1 day, M = days, L = 1-2 weeks.

---

## 1. Where June stands

June's foundation is unusually strong: execution-layer approval gate, fail-closed policy,
unattended observe-only leash, audit trail, resident-process architecture, pure tested cores
(187 TS + 17 Rust tests), honest deferral notes. The docs match the code (B4.11 even corrected
docs to post-fix reality).

What is missing versus BridgeAgent is the loop itself: recurrence finer than daily,
repeat-until conditions, verify-and-retry inside missions, run history you can review, and the
ability to create any of it by voice. The UI loses polish exactly where state lives longer than
a phase transition (reply dead-end, mission runner, model downloads) and where feedback should
close the loop (silent saves, silent TTS, invisible audit trail).

## 2. BridgeAgent (bridgemind.ai) research

bridgemind.ai and docs.bridgemind.ai 403'd direct fetches; catalog assembled from search-result
content plus bridgeagent.app. Marketing-level only - no public docs describe concrete loop
constructs. June's improvement-2/3/4 already adopted several BridgeAgent ideas (lessons =
playbook, triggers = production watch, missions, toolsets).

BridgeAgent ("The Recursive AI Software Engineer", beta, macOS + Windows):

- The loop (headline): design -> ship -> fix -> learn, repeated. Plans a mission, splits into
  verifiable tasks, writes code, runs tests, opens PRs, watches production after merge, loops
  back: error spike -> investigation -> fix PR -> incident becomes a new skill.
- Missions, not prompts: reports when the mission is done, not when a prompt is answered.
- Self-improvement: writes its own skills (~169 skills, 70+ tools), rewrites its playbook.
- Composable toolsets (~57) loaded per mission.
- Triggers from production monitoring (Sentry, PostHog) as a standing event loop.
- ~25 integrations (GitHub, Stripe, Sentry, PostHog, AWS/Azure/GCP, Vercel, Supabase, Linear,
  Jira, Notion, Slack, ...).
- Cloud execution ("runs with your laptop closed") - June's docs deliberately reject this as
  against local-first; a differentiation, not a gap.

Comparable-product baseline ("loops and other stuff" in n8n/Lindy/Zapier-agents/Claude
routines): interval + cron scheduling, event/webhook triggers, repeat-until loops,
conditionals, sub-agents, human-in-the-loop pause/resume, run history with replay, templates.

## 3. P0 - concrete defects (fix first)

**Status: all 10 items implemented on 2026-07-20** (typecheck, lint, 189 TS + 19 Rust
tests, clippy -D warnings, production build all pass). Notes: the approval countdown is
stamped client-side from the live `agent://approval` event (an approval seeded via
`pending_approval` shows no countdown rather than a wrong one); the mission runner is a
module singleton in src/lib/mission-runner.ts with recovery on app-window mount; the
scheduler persists fired-today state to `<app_data_dir>/june-scheduler.json`.

1. (S) Dictation toggle ON state never shows - CSS specificity bug. The shared button rule
   `.voice button:not(.orb):not(.open-app):not(.new-convo-orb)` (styles.css:448) forgets
   `:not(.dictation-toggle)`; it beats the 28x28 icon style (styles.css:155-172) and the
   latched `.dictation-toggle.on` state (styles.css:181-185). The blue "dictation on" fill is
   overridden by `background: transparent`, so on and off are indistinguishable - undoing
   B2.6's intent. Fix at styles.css:448/:464/:470.
2. (S) The `reply` phase is a hands-free dead end. `dictated` expires after 2.5s and `error`
   after 4s (VoicePanel.tsx:434-448) but nothing expires `reply`; the wake listener only arms
   while `phase.s === "idle"` (VoicePanel.tsx:499). With wake word enabled you can wake June
   exactly once; the widget card also never auto-collapses (`active = phase.s !== "idle"`,
   VoicePanel.tsx:620). Same bug class B2.5 fixed for `error`.
3. (M) Mission runner lives in a conditionally-mounted component. `MissionBoard` unmounts on
   tab switch (AppWindow.tsx:225-229) while `runMission` keeps running in an orphaned closure;
   on return `running` is false (MissionBoard.tsx:74): Stop is gone, a second mission can start
   concurrently. Closing the app window kills the runner, leaving the board stuck `active`
   forever, which pins the widget permanently expanded (VoicePanel.tsx:620) with no Clear
   (MissionBoard.tsx:166-170). Hoist the runner above the tab switch (module singleton or
   AppWindow-owned) + double-start guard + "runner lost" recovery. Fuller fix in section 5.
4. (S) Scheduler: a failed run never retries - `fire()` returns true on Err so the day is
   marked fired (scheduler.rs:149-153, 247-249). Also restart within the 30-min catch-up
   window double-fires (in-memory `fired` map, scheduler.rs:224-228). Retry next tick capped
   ~3; persist last-fired.
5. (M) Local model first run fails misleadingly. Moonshine (~190MB) downloads inside
   `transcribeLocal` but races a hard 20s timeout reporting "Check your connection"
   (VoicePanel.tsx:191-199); Kokoro (~86MB) downloads silently mid-SpeechQueue - UI sits in
   "Speaking..." with no audio. Exempt local STT from the timeout; add download progress
   (transformers.js exposes progress callbacks). Promised in improvement-4.md:110, never built.
6. (S) Rapid orb/PTT presses leak a hot mic. `startListening` has no in-flight guard
   (VoicePanel.tsx:240-263); overlapping `startCapture` calls (voice-capture.ts:193-215) both
   open getUserMedia and the second overwrites `capture.current` - first stream never stopped.
7. (S) Silent failures: settings saves swallow every error (`void saveSettings(next).catch(()
   => {})`, SettingsPanel.tsx:134, also :103); SpeechQueue eats TTS errors (tts.ts:123,
   145-146) so a dead TTS endpoint = text with no audio and zero explanation; fire-and-forget
   invokes with no catch (`void newConversation()` AppWindow.tsx:210, `void writeMission(null)`
   MissionBoard.tsx:167, `void openApp()` VoicePanel.tsx:733).
8. (S) Scroll behavior: app conversation force-smooth-scrolls on every streamed delta,
   yanking a user who scrolled up (AppWindow.tsx:185-190) - stick-to-bottom only when near
   bottom, instant during streaming. Widget card has no scroll-follow at all (styles.css:100-105)
   so long replies stream off-screen.
9. (S) Approval polish: no keyboard path for the most safety-critical control (no focus move,
   no Esc-to-reject; VoicePanel.tsx:882-896, AppWindow.tsx:260-277); danger class
   (`approval.cls`, session.ts:13-19) never shown; backend expiry at 120s (serve.ts:50) is
   silent - card just vanishes (session.ts:92-94). Unify ApprovalCard/ApprovalBanner, add tier
   chip + countdown + focus + Esc.
10. (S) Token hygiene: undefined `var(--fg)` (styles.css:780, should be --ink); stale fallback
    literals (styles.css:809 `6px` vs real 8px, :812 `#4f7cff` vs real #4b63e6); missing
    `scrollbar-width: thin` on .settings-view/.missions (styles.css:750, 1019); privacy-mode
    cards have no selected state beyond the radio dot (styles.css:938-946, one `:has(:checked)`
    rule); "Send to June" button reflows every countdown second (VoicePanel.tsx:945); status
    copy "press the orb to cancel" actually re-opens the mic (VoicePanel.tsx:861 vs 462-465).

## 4. P1 - the loops pack (the headline ask)

1. (S/M) Interval schedules ("every N minutes"). Extend `Schedule` with `kind: "daily"|"every"`
   + `everyMinutes` (src/lib/schedules.ts:18-28); generalize pure `is_due`
   (scheduler.rs:46-61) to track `last_fired: Option<NaiveDateTime>`; one extra Automation
   control. Tick/run_unattended/leash need zero changes. Cron stays the later upgrade.
2. (M) Watch loops / repeat-until - the headline. `WatchLoop = {prompt, everyMinutes,
   untilCondition}`: re-run an observe-only unattended turn on an interval, stop + notify when
   the condition holds ("check the build every ten minutes until it's green"). New entry type
   in schedules.ts + Automation UI; scheduler fires through existing `run_unattended`; frame
   prompt (reuse `frameUnattended`) to end "reply exactly DONE or CONTINUE + one-sentence
   status"; pure tested verdict parser (sibling of `parseTaskList`); cap iterations. The
   observe-only leash (serve.ts:166-184) makes this safe by construction.
3. (M) Run history ledger + Runs tab. Persist every unattended/mission/watch run ({id, source,
   prompt, started, ended, reply, isError, blocked[]}) to `<app_data_dir>/june-runs.jsonl`
   (rotate like audit, agent_runner.rs:61-63); Runs tab in AppWindow (RunsPanel.tsx, follow
   MissionBoard's shape) with past runs, replies, blocked-action badge, per-schedule "Run now".
   Also surface the audit.jsonl tail here - the UI currently only mentions it
   (SettingsPanel.tsx:1081, 1117); blocked unattended actions today vanish into one transient
   notification (agent_runner.rs:568-578). Both deep dives flagged this as the biggest
   trust-surface gap.
4. (M/L) Mission loop: verify -> retry -> re-plan. After each task an optional cheap
   verification turn ("PASS/FAIL + one reason"); on FAIL one retry with failure context; at
   mission end a single fix pass over failures. Today success is the brain grading its own
   homework (isError only). Extend runMission + MissionTask (missions.ts pure reducer); reuse
   the verdict parser from item 2. Lessons (17.1) give the "learn" leg.
5. (M) Voice-created automations: tiny built-in `mcp/automation` server (sibling of
   mcp/memory) exposing start_mission, add_schedule, add_watch, list_automations. Classify
   add_* as `expensive` (gated, spoken-approvable) in policy.ts ACTION_CLASS + BUILTIN_SERVERS.
   Writes go through a Tauri-side settings merge; the scheduler re-reads settings every tick so
   a written schedule is live within 30s. Today missions/schedules are keyboard-only - the
   flagship autonomy feature of a voice agent starts from a textarea, and the system prompt
   (agent/prompt.ts:7-21) never mentions automations. Biggest UX unlock.

## 5. P2 - missions grow up

1. (S) Pass context between tasks. Each task's whole prompt is its bare title in a fresh
   conversation (MissionBoard.tsx:59) - task 3 never sees task 1's output. Capped digest of
   prior replies via a pure helper in missions.ts (~20 lines).
2. (M/L) Move the mission runner into Rust: `run_mission` command driving decompose/dispatch
   from a Rust thread (scheduler-style), webview a pure viewer of `mission://updated`; resume
   an `active` board on startup. Also fixes: speaking to June mid-mission preempts the active
   task (serve.ts:343-347) so `advanceMission(mission,false)` fails it (MissionBoard.tsx:59-63)
   - Rust-side runner can schedule around interactive turns using `is_busy`. (The P0-3 hoist is
   the quick webview-side stopgap; this is the durable fix.)
3. (S/M) Mission plan confirmation: show the decomposed task list with Confirm/Edit before
   execution (runMission currently plans and immediately runs).
4. (M) Wire composable toolsets: `relevantServers` exists and is tested (missions.ts:130-134)
   but `toolsetIds` is never populated (acknowledged dormant, B4.11). Ask the brain to name
   needed servers at decomposition; enforce via per-task respawn with filtered
   JUNE_MCP_SERVERS.

## 6. P2 - product parity and voice UX

1. (M) Text composer in the app Conversation view - input + send wired to existing
   `run_agent`. The only way to command June today is voice through the widget; Claude
   desktop / ChatGPT treat voice + keyboard as equals. Backend needs nothing new. Biggest
   single parity win.
2. (L) Live interim transcript while speaking (deferred Phase 12.6, improvement-4.md:116-122).
   You currently speak against a waveform and see zero words until transcription completes -
   the single largest perceived-quality gap vs ChatGPT voice mode.
3. (M) Keyboard pass: autofocus + Ctrl+Enter/Esc in ReviewCard (VoicePanel.tsx:932-966),
   Enter-to-save in KeyGate (VoicePanel.tsx:969-994) and KeyRow (SettingsPanel.tsx:414),
   aria-current on tabs (AppWindow.tsx:196-214).
4. (M) Accessibility pass (deferred 16.5): no aria-live anywhere - status should be
   role="status", errors role="alert", approvals announced; real labels across Settings
   (.stage-label is a span, SettingsPanel.tsx:262-268; selects labeled only by title,
   :287, :330); weekday chips ~30x22px with no aria-pressed (styles.css:803-815,
   SettingsPanel.tsx:1140-1156); field focus is a 1px border-color change vs the strong global
   outline (styles.css:422-426, 866-879 vs 67-70). Keep the good parts: aria on widget icons,
   reduced-motion coverage, engineered contrast (all spot-checks pass AA).
5. (M) Mic device picker (getUserMedia takes OS default, voice-capture.ts:196), mute /
   stop-speaking affordance, output volume. No mainstream voice product ships without input
   selection.
6. (M) Configurable PTT hotkey + first-run verification (improvement-3 2.4); the string
   "Ctrl + Shift + Space" is duplicated in four places (VoicePanel.tsx:858-859,
   AppWindow.tsx:217/234, SettingsPanel.tsx:472-474) - centralize.
7. (S) Widget tool visibility: during a long tool call the widget shows only "Working on
   it..." - add a compact tool-name line (app window gets chips, widget gets nothing;
   AppWindow.tsx:249-258 also shows raw snake_case names with no running-state pulse -
   humanize via actionOf, agent/policy.ts:106-108).
8. (S) STT Test button records 2.5s with no "speak now" indicator (SettingsPanel.tsx:246-257);
   CaptureHandle.level is sitting right there for a live meter.
9. (S) Set app window theme to dark (WebviewWindowBuilder.theme) - content is always dark but
   the Windows titlebar follows OS theme (white titlebar in light mode); decide dark-only
   explicitly (styles.css:1-2).
10. (M) Design tokens: ~5-size type scale instead of nine ad-hoc sizes (10.5-16px), 4px
    spacing scale; fold the two level-scaling magic numbers (orb `level*6` VoicePanel.tsx:785,
    wave `v*8` :845) into one constant.
11. (M) Widget expanded sizing: fixed 340x440 slab (lib.rs:142) shows mostly-empty dark
    rectangle for one-line content - size window to card content or cap headroom.
12. (S) Settings sections pop-in: MemorySection/LessonsSection return null until file reads
    resolve (SettingsPanel.tsx:722, 785) - reserve space or skeleton.

## 7. P3 - trust, isolation, ship

1. (S/M) Isolate unattended runs from the interactive conversation: they currently share it
   (ponytail note, agent_runner.rs:795-798) - context pollution both directions. Add
   `fresh: true` to the unattended request; serve.ts resets before it (only fires when idle).
2. (L) Sidecar packaging (deferred 16.4): resident requires npx/tsx/Node and the repo checkout
   at the build machine's absolute path (CARGO_MANIFEST_DIR, agent_runner.rs:378-383, 402-418;
   every MCP server likewise, agent/core.ts:44-98). Gates real adoption of everything above -
   esbuild single-file bundle + node.exe as a Tauri resource.
3. (S/M) Approvals inbox: persist blocked/pending items, badge both faces, "re-run attended"
   button - the honest middle step toward 18.2's true pause/resume. (Overlaps Runs tab, 4.3.)
4. (S/M) Keychain-backed MCP secrets: GitHub tokens etc. are plaintext in settings.json
   (acknowledged 13.5); reuse keychain.rs, env/headers become keychain refs.
5. (M) MCP health probe + tool inspector (13.5 tail): adding a server gives zero feedback
   until a turn fails; enables per-tool class promotion.
6. (S/M) Persisted conversation history (opt-in, standard privacy mode only): session log is
   in-memory (capped 500, agent_runner.rs:179, cleared at :230-234) - both faces open empty
   every launch; "what did my 9am briefing say yesterday?" is unanswerable (overlaps run
   ledger).
7. (M) SSE streaming for OpenAI-compat brains (openai-brain.ts is non-streaming; fights the
   800ms voice-to-voice target).
8. (M) Train a real "hey june" wake model - the local wake word is literally the hey_jarvis
   stand-in; drops into createWakeRunners with no code change.
9. (M) Claude-brain context is untrimmed within a session (claude-brain.ts:137-157; OpenAI
   path trims at 60 messages per B4.5) - only the 10-min idle reset bounds it.
10. Known deferred items that still gate acceptance: bridge ApprovalToken never verified
    (16.1) so any local process with the discovery token bypasses the gate outside June;
    observe() resume never happens (16.2); the live mic round-trip manual pass (10.9) pending
    since Phase 4.

## 8. Explicitly not proposed

Cloud-side execution (BridgeAgent's headline) - local-first is June's differentiator.
Computer-use stays requirement-gated (19.4). Vector memory unnecessary at current corpus
sizes.
