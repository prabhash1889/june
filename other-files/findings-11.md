# June - Deep-Dive Review (findings-11)

**Date:** 2026-07-21
**Baseline:** HEAD `6d78382b` (improvement-7 1.4). Reviewed via the knowledge graph
(`graphify-out`, current with HEAD), full check runs, and direct reads of the core
modules (agent_runner.rs, scheduler.rs, serve.ts, policy.ts, VoicePanel.tsx,
SettingsPanel.tsx, MCP servers, config). Findings only - no code changed.

## Verified health baseline

| Check | Result |
|---|---|
| `npm run typecheck` (7 tsconfigs) | Clean |
| `npm test` (vitest) | 302/302 pass (37 files) |
| `cargo test` | 52/52 pass |
| `cargo clippy --all-targets -D warnings` | Clean |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run lint` | **Fails - 20 errors** (see 1.1) |

The codebase is unusually well-commented and the safety architecture
(execution-layer gate, fail-closed unattended runs, PTT-gated dictation injection,
keychain-only provider keys, minimal Tauri capabilities) is genuinely solid. The
findings below are about polish, drift, and the next layer of maturity.

---

## 1. Broken right now

**1.1 Lint fails after a packaging build.** `scripts/bundle-agent.mjs` outputs
bundled artifacts to `src-tauri/resources/agent/*.mjs`, but `eslint.config.js`
`ignores` only covers `dist`, `node_modules`, `src-tauri/target`, `src-tauri/gen`,
`coverage`. ESLint then scans the 36k-line bundles and dies with 20 "rule not
found" errors. CI passes only because `src-tauri/resources/` is gitignored, so CI
never has the bundles present. Locally, `npm run lint` is red for anyone who has
run a Tauri build - which contradicts the "eslint zero warnings" exit claim
repeated in bugs1.md. Fix: add `src-tauri/resources` (and `src-tauri/binaries`,
`public/models`, `graphify-out`, `other-files`) to the ignore list.

## 2. Documentation drift (the front door is wrong)

**2.1 README.md describes a different product.** It says: "Phase 0 (foundations)
complete - an empty Tauri window with tray presence... No voice, no agent loop, no
capabilities yet." Reality: full voice pipeline (wake word, VAD, barge-in, PTT,
dictation, quick capture), a resident agent with two brains, six built-in MCP
servers, missions, schedules, a run ledger, packaging, auto-update, and a real
tray menu. Anyone cloning this repo gets a completely false picture.

**2.2 PLAN.md status is a month stale.** Dated 2026-07-15, "Phases 0-9 complete".
Since then: bug-fix plan B1-B4, improvement rounds 5-7 (phases 10-19+), sidecar
bundling, signed updater, autostart, tray menu have all landed.

**2.3 Stale inline comments.** `VoicePanel.tsx:196` and `SettingsPanel.tsx:782`
both say "there is no local voice provider yet" - but `local-stt.ts` (Moonshine)
and `local-tts.ts` (Kokoro) exist and are wired into the provider roster. Comments
asserting architectural facts rot fastest; these two now mislead.

**2.4 agent/README.md is also stale** - describes the agent as "text-only,
Phase 3, the only committed brain is Claude" while `openai-brain.ts` and the
resident `serve.ts` exist beside it.

## 3. Architecture and code health

**3.1 God files.** The graph confirms what line counts suggest:
- `AgentSession` - 63 edges, betweenness 0.222, the single cross-community bridge
  of the whole app. `agent_runner.rs` is 1,800 lines doing spawn supervision, turn
  routing, approvals, ledger, usage, latency, memory IO, and health.
- `VoicePanel.tsx` - 1,325 lines, 22 `useEffect`s, ~30 refs. The hand-rolled phase
  machine (11 states) with ref-mirrored state is the most defect-prone file in the
  app; most of bugs1.md's B2 regressions lived here. A reducer or explicit state
  machine would make illegal transitions unrepresentable.
- `SettingsPanel.tsx` - 1,961 lines (well-decomposed into ~30 section components,
  but one file). Splitting into `src/settings/` per-section files is cheap and
  pays off in reviewability.
- `scheduler.rs` - 1,085 lines mixing schedules, watches, triggers,
  once-reminders, and mission kickoff.

**3.2 Mutex poisoning risk in `agent_runner.rs`.** 59 `.lock().unwrap()` calls in
production paths. One panic anywhere a lock is held poisons that mutex
permanently - every subsequent agent command then panics too, and the resident is
unrecoverable without an app restart. Poison-tolerant locking (or `parking_lot`)
is the standard hardening here.

**3.3 Ref-during-render writes in VoicePanel** (`dictationRef.current = dictation;
approvalRef.current = approval;` at render time). Works today, but it's a React
anti-pattern that can tear under concurrent rendering; an effect or the
"latest ref" pattern is safer.

**3.4 Windows-only in practice, cross-platform in CI.** `mcp/system` shells out to
PowerShell (`-EncodedCommand`) for active-context; the whole voice/dictation stack
assumes Windows (`SendInput`, NSIS installer). Yet the Rust CI matrix builds macOS
too, implying a support level the product doesn't have. Either declare
Windows-only (cheaper, honest) or gate the macOS CI to compile-only with a note.

## 4. Security and privacy (strong core, known gaps)

Already fixed and verified by tests (bugs1.md B1-B3): tool-name spoofing,
bare-name collisions, unattended privilege, spoken-approval fail-open,
reserved-id shadowing, blind approvals. Remaining exposure, all already on the
improvement-7 radar but worth restating by risk:

- **4.1 MCP server secrets are plaintext in settings.json** (env/header values).
  Highest-value open security item (7-4.3).
- **4.2 The bridge never verifies the ApprovalToken** - any local process with the
  discovery token bypasses the gate outside June (7-4.5).
- **4.3 Blocked unattended actions evaporate** - no approvals inbox means the
  leash silently drops work (7-4.1). This is a correctness-of-trust issue, not
  just UX.
- **4.4 CSP still allows `style-src 'unsafe-inline'`** - flagged in 2.4(d) as
  removable pending a device pass.

## 5. Testing and CI

- **5.1 No E2E harness.** The orphan-webview/kill-tree defect class is invisible
  to unit tests (7-7.1). Now that release CI produces builds, the tauri-driver
  smoke test is unblocked and overdue.
- **5.2 Coverage is unmeasured.** 36 test files vs 68 source files. Untested
  modules include the riskiest glue: `session.ts` (cross-window events,
  turn-number allocator), `stt.ts`, `local-stt.ts`, `vad.ts`, `errorlog.ts`,
  `ErrorBoundary.tsx`, `WidgetWindow.tsx`. No coverage tool or threshold is
  configured, so this regresses silently.
- **5.3 Version consistency is only checked in release.yml**, not ci.yml - a PR
  can desync `package.json` / `tauri.conf.json` / `Cargo.toml` and master CI stays
  green until release time.
- **5.4 No supply-chain or bundle-budget gates** (7-7.2): no `cargo audit` /
  `npm audit` job, no size assertion on the code-split chunks. The `local-tts`
  chunk is already 1.3MB and `xformers` 825KB - exactly the kind of thing that
  regresses silently.
- **5.5 Lint isn't protecting you right now** (see 1.1) - so the CI "lint" gate
  currently verifies a tree that differs from every developer's working tree after
  a build.

## 6. Product polish

- **6.1 The wake phrase is "hey jarvis", not "hey June"** (`wakeword.ts`,
  `fetch-models.mjs`). For a product named June this is the single most visible
  branding bug; 6.2 correctly classifies it as a training task, not code - but it
  should be scheduled, since every demo says the wrong name.
- **6.2 Settings panel depth vs. discoverability.** 30+ sections in one scrolling
  panel with a section nav; capabilities like the MCP catalog, per-tool class
  promotion, and memory/lessons viewers (7-3.4, 7-4.4) are where users will get
  lost first.
- **6.3 Accessibility pass pending** (7-7.3): `styles.css` has some `:focus` rules
  (11 matches) but no aria-live on transcript/approval surfaces was evident, and
  the 88px orb is a pointer-only target. Approvals are the safety-critical UI -
  they deserve the keyboard/screen-reader path first.
- **6.4 Dark-only.** `tauri.conf.json` pins `"theme": "Dark"` and the palette is
  hardcoded (7-7.4).
- **6.5 Conversation amnesia.** Session log is in-memory; restart wipes both
  faces (7-3.1). Combined with no `recall_runs` tool (7-3.2), "what did my 9am
  briefing say?" is unanswerable - the most requested thing for an assistant that
  runs unattended.
- **6.6 Latency work is gated on a missing gauge** (7-2.2): no per-synth TTS
  timing, so the 800ms voice-to-voice target is currently unmeasurable
  end-to-end.

## 7. Repo hygiene

- `other-files/` (untracked) holds deleted improvement plans 1-6 plus findings
  docs; `bugs1.md` and `improvement-7.md` sit at root. A `docs/plans/` folder
  (tracked) would preserve history without the duplicate untracked copies.
- `overview.html` (a styled landing page) and `images/sample-image-1.png` live at
  the repo root with no clear role.
- 8 deleted-but-not-committed plan files in `git status` - the working tree is
  mid-cleanup.

---

## Suggested priority order

1. **Fix lint** (1.1) - one line, restores the gate you think you have.
2. **Rewrite README** (2.1) - it's actively false today.
3. **Mutex poisoning hardening** (3.2) - the only crash-class risk found in the
   Rust core.
4. **Keychain-backed MCP secrets** (4.1) - biggest real security gap.
5. **E2E smoke harness + version check in CI** (5.1, 5.3) - now that installers
   ship from CI.
6. **VoicePanel state machine extraction** (3.1) - the file where regressions
   keep happening.
7. **Coverage measurement + thresholds** (5.2) - before more features land on
   untested glue.
8. **"hey june" wake model** (6.1) - schedule the offline training task.

The engineering bar here is already high (disciplined gate design, regression
tests pinned to every fix, honest comments citing plan sections). The main theme
of the findings: the *machinery around* the code - lint config, README, coverage,
CI gates - has fallen behind the code itself, and the two biggest files
(VoicePanel, agent_runner) are where the next generation of bugs will be born.
