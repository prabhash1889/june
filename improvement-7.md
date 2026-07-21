# Improvement round 7: from working prototype to shippable product

Deep-dive over the post improvement-6 codebase (all of rounds 1-6 landed except the four
Phase 8 bets and the device-gated deferrals). June today: full voice pipeline (wake/VAD/
local+cloud STT+TTS/barge-in/PTT/dictation/quick capture), two brains behind one policy
gate, six built-in MCP servers, schedules/watches/triggers/once-reminders, missions with
verify, run ledger + usage accounting, file logging, onboarding. The prototype is feature
-rich; what it is NOT yet is a product someone else can install, trust, and keep.

Round 7 theme: **ship it, speed it up, give it a memory, then make it ambient.**

Legend: P0 = do first, P3 = later. S/M/L = effort. (c/o = carry-over from a prior round's
deferred list; everything unmarked is new this round.)

---

## Phase 1 - Ship it (packaging and distribution) - the adoption gate

Everything in rounds 1-6 only runs from this repo checkout on this machine: the resident
needs `npx`/`tsx`/Node and resolves `agent/serve.ts` + every MCP server via the build
machine's absolute `CARGO_MANIFEST_DIR` path. Nobody else can run June. Fix that first -
every other improvement multiplies in value once the app is installable.

1.1 **Sidecar-bundle the agent** (c/o 5-P3.2) | P0 | L - DONE
    esbuild `agent/serve.ts` and each built-in MCP server (`mcp/*/server.ts`) into
    single-file bundles under `src-tauri/resources/agent/`; ship a pinned `node.exe` as a
    Tauri sidecar. `spawn_serve()` resolves `resource_dir()` in release builds and keeps
    the tsx dev path in debug builds. MCP configs in `agent/core.ts` switch from
    `npx tsx <repo path>` to `<sidecar node> <bundled js>`. Kill every
    `CARGO_MANIFEST_DIR` runtime dependence.
    `src-tauri/src/agent_runner.rs`, `agent/core.ts`, new `scripts/bundle-agent.mjs`,
    `src-tauri/tauri.conf.json` (resources + externalBin).

1.2 **Signed installer + auto-update** | P0 | M - DONE
    (Updater keypair generated; private key stays in src-tauri/.tauri-signing.key,
    git-ignored - add it as the TAURI_SIGNING_PRIVATE_KEY GitHub Actions secret.
    Authenticode code-signing needs a purchased cert; the update channel is signed
    via the tauri/minisign keypair.)
    `tauri-plugin-updater` + NSIS target, update manifest on GitHub Releases, a CI
    release job (`tauri build` on a Windows runner, upload artifacts). Version bump
    discipline: one `version` source (tauri.conf.json) checked against package.json in CI.
    An assistant that self-updates is table stakes for trusting it with automations.
    `.github/workflows/release.yml`, `src-tauri/tauri.conf.json`, `Cargo.toml`.

1.3 **Autostart + start-in-tray** | P1 | S
    `tauri-plugin-autostart` behind a `launchAtLogin` setting (default off, offered once
    during onboarding). A voice assistant that dies at reboot is not an assistant.
    `src-tauri/src/lib.rs`, `src/lib/settings.ts`, `SettingsPanel.tsx`, onboarding card.

1.4 **A real tray menu** | P1 | S/M
    Today the tray is icon + Quit. Add: Open June (app window), Mute microphone (kills
    wake + PTT capture, icon badge while muted), Pause automations (scheduler no-op flag,
    also badge), Privacy mode submenu, Quit. All four states already exist as settings or
    scheduler flags - this is wiring, not machinery.
    `src-tauri/src/lib.rs`, `scheduler.rs`, `src/lib/settings.ts`.

1.5 **First-run model download UX** | P2 | S/M
    `fetch-models.mjs` runs at build time, but the webview also pulls Moonshine/Kokoro/
    Silero from HF at first use with only a tiny progress hint. Surface one aggregate
    "Setting up on-device voice (34/120 MB)" progress row in onboarding, wired to the
    existing `model-progress.ts`; block the "local" provider pickers until ready instead
    of failing the first turn.
    `src/lib/model-progress.ts`, onboarding in `AppWindow.tsx`, `SettingsPanel.tsx`.

---

## Phase 2 - Faster (latency and startup)

The 800ms voice-to-voice target is still fought by a non-streaming OpenAI brain and an
unmeasured TTS leg. Also: measure before optimizing - two items here are metrics that
unblock gated work from round 6.

2.1 **SSE streaming for the OpenAI-compat brain** (c/o 5-P3.7) | P1 | M
    `openai-brain.ts` is non-streaming: `onText` fires once per assistant message, so
    first audio waits for the whole completion. Add `stream: true` SSE parsing (fetch +
    ReadableStream, no new dep), emit text deltas into the existing SentenceBuffer,
    keep non-streaming as fallback for endpoints that reject `stream`. This also makes
    the Ollama/LM Studio local brains feel dramatically faster.
    `agent/openai-brain.ts` (+ tests mirroring claude-brain's delta/fallback pins).

2.2 **Per-synth TTS duration metric** (unblocks 6-3.12) | P1 | S
    `latency.ts` only records firstAudio-firstToken, conflating brain streaming with
    synthesis. Time each `synthesize()` call, record p50/p95 in Diagnostics beside the
    existing percentiles. This is the stated gate for streaming TTS - build the gauge.
    `src/lib/tts.ts`, `src/lib/latency.ts`, Diagnostics panel.

2.3 **Stream cloud TTS playback** (c/o 6-3.12, gated on 2.2) | P2 | M
    If a device shows synth p50 meaningfully above ~300ms: `synthesize_stream` in Rust
    forwarding `resp.chunk()` over a Tauri channel (honoring the 3.11 cancel registry)
    into a MediaSource buffer in `SpeechQueue`. If the gauge says under 300ms, close
    this permanently.
    `src-tauri/src/tts.rs`, `src/lib/tts.ts`.

2.4 **Device lab session: close the audio deferrals** (c/o 6-3.3/7.12) | P1 | M
    One sitting on a real Windows mic, four items that only exist there:
    (a) replace MediaRecorder(webm) with PCM+WAV capture so the warm `PreRollRing` is
    finally PREPENDED to wake/follow-up clips (kills first-word clipping);
    (b) warm-`MicVAD` reuse across consumers (one Silero instance, not one per phase);
    (c) measure barge-in latency and time-to-first-audio before/after (pin numbers in
    Diagnostics);
    (d) run the built app and drop CSP `style-src 'unsafe-inline'` if the console stays
    clean across a full voice turn + settings render.
    `src/lib/mic.ts`, `voice-capture.ts`, `vad.ts`, `src-tauri/tauri.conf.json`.

2.5 **Claude-brain in-session context trim** (c/o 5-P3.9) | P1 | S
    The OpenAI path trims at 60 messages; the Claude path grows unbounded until the
    10-min idle reset - long sessions get slower and pricier every turn. Use the SDK's
    compaction/`maxTurns` session controls or reset-with-summary at a message-count
    threshold, mirroring the OpenAI trim rule.
    `agent/claude-brain.ts`.

2.6 **Cold-start budget** | P2 | S/M
    Nobody has measured widget time-to-interactive. Log `performance.now()` milestones
    (webview load, React mount, wake listener live) into june.log on startup; defer
    Kokoro/Moonshine loads until a mode that needs them is active (today the widget may
    warm models a cloud-mode user never uses). Set a budget (<2s to responsive orb) and
    pin the regression in Diagnostics.
    `src/main.tsx`, `src/widget/WidgetWindow.tsx`, `src/lib/local-stt.ts`, `local-tts.ts`.

---

## Phase 3 - A memory (conversation continuity)

June forgets everything at every launch: session log is in-memory (capped 500, cleared on
restart), both faces open empty, and "what did my 9am briefing say yesterday?" is
unanswerable even though the ledger holds the answer.

3.1 **Persisted conversation history** (c/o 5-P3.6) | P1 | M
    Opt-in, standard privacy mode only (on-device modes stay ephemeral - same rule as the
    ledger redaction). Persist the session transcript to `june-history.jsonl` (fsutil
    atomic write + rotation, capped), restore into both faces on launch with a visible
    "earlier" divider. Clear via the existing `clear_recorded_data` path (7.11) so one
    button wipes everything.
    `src-tauri/src/agent_runner.rs`, `src/app/AppWindow.tsx`, `src/lib/transcript.ts`.

3.2 **`recall_runs` observe tool** | P1 | S/M
    "What did my briefing say yesterday" / "what failed overnight" should be answerable
    BY June, not just visible in a tab. New observe-class tool in `mcp/system` (or a tiny
    `mcp/runs` server) that greps the run ledger by source/day/outcome and returns capped
    matches. Local, read-only, unattended-safe; the ledger already redacts under
    on-device modes so privacy holds by construction.
    `mcp/system/server.ts`, `agent/policy.ts`.

3.3 **Isolate unattended runs from the interactive conversation** (c/o 5-P3.1) | P1 | S
    They still share the resident's conversation - a scheduled briefing pollutes your
    chat context and vice versa. Add `fresh: true` on the unattended request; serve.ts
    resets before it (unattended only fires when idle, so nothing user-facing is lost).
    `agent/serve.ts`, `agent/protocol.ts`, `src-tauri/src/agent_runner.rs`.

3.4 **Memory browser** | P2 | S
    june-memory.md, june-inbox.md and the lessons store are invisible - the user cannot
    see or fix what June "knows" about them, which is a trust problem. Read-only viewer +
    delete-line affordance for all three in a Settings "What June remembers" section,
    reusing the existing contained-path readers.
    `SettingsPanel.tsx`, small `read_memory_files` command in `src-tauri`.

3.5 **Cost over time** | P2 | S
    Per-run usage already rides the ledger (6-2.6) but Diagnostics only shows the live
    session. Aggregate the ledger into a today/7-day/30-day spend + turn-count readout
    (pure TS over `read_runs` output, no new storage).
    `src/lib/runs.ts`, Diagnostics panel.

---

## Phase 4 - Trust surfaces (approvals grow up)

The gate works but the experience around it is thin: a blocked unattended action
evaporates, secrets sit in plaintext, and adding an MCP server is fire-and-pray.

4.1 **Approvals inbox** (c/o 5-P3.3) | P1 | M
    Persist gated actions that were blocked unattended (and approvals that timed out) to
    a small JSONL; badge both faces; each card shows the summarize() line with
    "Run now attended" / "Dismiss". Closes the loop on the unattended leash: blocked no
    longer means silently lost.
    New `src-tauri/src/inbox.rs` (fsutil-backed), `agent/serve.ts` (emit blocked events),
    `src/app/AppWindow.tsx`, widget badge.

4.2 **Approve from the notification** | P2 | S/M
    An approval request while the app window is closed is easy to miss (the widget is
    88px). OS notification on gate-pending with the summarize() line; clicking focuses
    the approval card (deep-link into the widget/app). True action buttons if the
    notification plugin supports them on Windows; focus-on-click otherwise.
    `src-tauri/src/agent_runner.rs`, notification plugin wiring.

4.3 **Keychain-backed MCP secrets** (c/o 5-P3.4) | P1 | S/M
    GitHub tokens etc. are plaintext in settings.json. Env/header values in a server
    config may be written as `keychain:<service>` refs; resolution happens in Rust at
    spawn-request time (the resident receives resolved values, disk never holds them).
    Settings UI gets a "store in keychain" toggle per secret field; migration offers to
    move existing plaintext values.
    `src-tauri/src/keychain.rs`, `agent_runner.rs`, `src/lib/mcp-servers.ts`,
    `SettingsPanel.tsx`.

4.4 **MCP health probe + tool inspector** (c/o 5-P3.5) | P1 | M
    Adding a server gives zero feedback until a turn fails. "Test" button per server:
    spawn, `tools/list`, report tool names + classes + error verbatim. The tool list then
    powers per-tool class promotion (promote a read tool to observe from the UI instead
    of editing JSON) - the missing half of the catalog's `defaultClass` stance.
    New `agent/probe.ts` (reuses core.ts config building), `probe_mcp_server` command,
    `SettingsPanel.tsx`.

4.5 **Verify the bridge ApprovalToken** (c/o 5-item 10) | P2 | M
    Any local process with the discovery token still bypasses the gate outside June -
    the bridge never verifies the ApprovalToken. The June side should sign/attach it
    correctly and fail closed when the bridge reports verification unsupported; the
    bridge-side check is external to this repo but the contract + golden file pin lands
    here. `src/contract/types.ts`, `mcp/saple-bridge-control/`.

---

## Phase 5 - New capabilities

5.1 **Image paste/drop in the composer** (c/o 6-8.2) | P1 | M
    Paste an error-dialog screenshot, ask "why?". Accept clipboard/drag images in the
    composer, ship as an image content block (Claude brain first; OpenAI-compat where the
    model supports vision), thumbnail in the transcript bubble. Cloud-only: blocked under
    on-device modes with an honest one-liner. The user supplying pixels sidesteps the
    blocked auto-capture path entirely.
    Composer in `AppWindow.tsx`, `agent/serve.ts` message shape, both brains,
    `agent/protocol.ts`.

5.2 **Away digest** (c/o 6-8.1) | P1 | M
    Idle detection via `GetLastInputInfo` in the existing 30s tick; on return after N
    idle minutes, one compact "while you were away" card (runs, fired triggers, inbox
    items from 4.1) + optional spoken one-liner. Pure aggregation over existing data.
    `src-tauri/src/scheduler.rs`, `src/lib/runs.ts`, `src/widget/WidgetWindow.tsx`.

5.3 **SAPLE morning standup template** (c/o 6-8.3) | P2 | S
    One-click schedule template whose prompt walks `get_swarm_status`/`list_incidents`/
    `list_tasks` into a spoken 30-second digest - curated prompt, not machinery. Ship as
    a "Templates" row above the schedule editor (briefing / standup / build watch).
    `SettingsPanel.tsx`, `agent/prompt.ts`.

5.4 **Browser tab URL in `get_active_context`** | P2 | S/M
    The round-6 item shipped title + process; the "which article am I reading" half needs
    the URL. UI Automation address-bar read for the big three browsers via the same
    PowerShell `-EncodedCommand` seam, degraded gracefully to title-only. Still
    metadata-only, observe-class, audit-logged.
    `mcp/system/server.ts`, `parse.ts`.

5.5 **Explicit-consent screen glance** | P3 | M
    "Look at my screen" as a user-initiated, per-invocation capture: gated action class
    (never observe, never unattended), captures the foreground window only, thumbnail
    shown in the approval card BEFORE the model sees it. Composes with 5.1's image
    plumbing; without 5.1 this item does not start.
    `src-tauri` capture command, `agent/policy.ts` (new gated class), approval card UI.

5.6 **Reply markdown rendering** | P2 | S
    Replies with paths, code and lists render as flat text in `.turn.june` bubbles. Tiny
    md subset renderer (bold, inline/fenced code with the 6.5 copy button per block,
    links opened via the validated `open_path` seam, lists) - no raw-HTML path, no new
    heavyweight dep.
    `src/app/AppWindow.tsx`, `styles.css`.

---

## Phase 6 - Ambient intelligence (bigger bets)

6.1 **Smart brain routing** | P2 | M
    Every turn pays the flagship model, including "what time is it". Route by a cheap
    local heuristic (turn length, tool-likelihood, mission vs chat): simple turns go to a
    configured fast/cheap model (Haiku / gpt-4o-mini / local Ollama), complex turns and
    missions to the main model. One `routing` setting (off / auto), routing decision
    logged per run so cost savings are visible in 3.5's readout. Off by default.
    `agent/serve.ts`, `agent/brain.ts` (brain-per-turn selection), `settings.ts`.

6.2 **Train and ship `hey_june.onnx`** (c/o 5-P3.8 / 6-3.10) | P2 | M (offline GPU work)
    The wake phrase is still literally "hey jarvis". The code seam is confirmed ready
    (zero code change). Run the openWakeWord recipe (synthetic TTS positives + negatives),
    host the artifact, add the `{url, dest, sha256}` row to `scripts/fetch-models.mjs`.
    This is a training task, not a coding task - schedule it as one.

6.3 **Owner voice verification** (c/o 6-8.4) | P3 | L
    An always-listening mic that obeys anyone in the room is a real trust gap. Local
    speaker-embedding model (ECAPA onnx beside the existing ORT stack), one-time
    enrollment in Settings; below-threshold voices get wake acknowledgment but
    observe-only policy (a new policy input, not a new gate). Fully local, survives
    strict offline.
    `src/lib/wakeword.ts`, `ort-assets.ts`, `agent/policy.ts`, `SettingsPanel.tsx`.

6.4 **Watch-loop notifications with substance** | P3 | S
    A fired watch says it fired; it should say what changed ("build went green after 4
    checks, 22 min"). Carry the last observe result + check count into the notification
    and ledger record. `src-tauri/src/scheduler.rs`.

---

## Phase 7 - Quality bar (test, CI, polish)

7.1 **E2E smoke harness** (c/o 6-7.13) | P1 | M/L
    The orphaned-webview class (see memory: mouse-input-killing webviews, sync-command
    deadlocks) is invisible to unit tests. `tauri-driver` + WebdriverIO under `e2e/`:
    build debug app, assert both windows respond, one stubbed turn round-trips, quit
    leaves no orphan node/tsx process (the 1.10 kill-tree regression). Windows CI job
    with WebView2. This stops being "not cheap" the moment Phase 1 makes builds a CI
    artifact anyway.
    New `e2e/`, `.github/workflows/ci.yml`.

7.2 **Supply-chain + budget checks in CI** | P2 | S
    `cargo audit` + `npm audit --omit=dev` jobs (non-blocking report first, then ratchet);
    a bundle-size budget assertion on the vite build (the 7.3 chunk split regresses
    silently today); `cargo deny` licenses optional.
    `.github/workflows/ci.yml`.

7.3 **Accessibility pass on both faces** | P2 | S/M
    The approval card, orb states and settings controls need: visible focus rings,
    aria-live on the transcript/approval announcements, contrast check on the dark
    palette, full keyboard path through an approval (partially there via useApprovalKeys).
    One sitting with the axe devtools + manual tab-through.
    `src/styles.css`, `AppWindow.tsx`, `VoicePanel.tsx`.

7.4 **Light theme** | P3 | S/M
    tauri.conf pins `"theme": "Dark"` and the palette is hardcoded. CSS-variable-ize the
    palette, add `prefers-color-scheme` auto + a three-way setting (auto/dark/light).
    Pure CSS + one setting; do it with 7.3 since both touch every surface.
    `src/styles.css`, `settings.ts`, `tauri.conf.json`.

---

## Suggested order of attack

1. **Phase 1 first and alone** - packaging changes touch spawn paths everywhere; land it
   before new features pile onto the old absolute-path assumptions. 1.1 -> 1.2 unblocks
   the release CI that 7.1/7.2 ride on.
2. **Phase 2 next** (2.2 and 2.5 are afternoon-sized; 2.1 is the headline latency win;
   2.4 needs one scheduled device session).
3. **Phase 3 + 4 interleaved** - continuity and trust are the same story ("June remembers,
   and you can see and control what it does with that").
4. **Phase 5 by taste** after the plumbing exists (5.1 before 5.5; 5.2 after 4.1 so the
   digest includes inbox items).
5. **Phase 6 as capacity allows** - 6.2 is schedulable offline work; 6.1 lands best after
   3.5 makes its savings visible.
6. **Phase 7 rides along**: 7.1 right after Phase 1 (builds exist), 7.3/7.4 together.

## Explicitly not proposed

Cloud-side execution (local-first is the differentiator). Vector/semantic memory (corpus
still tiny; the md files + lessons + 3.2's ledger grep cover recall). Full computer-use /
continuous screen watching (stays requirement-gated; 5.5 is the consent-shaped slice).
i18n (single-user product, English STT/TTS stack; revisit if the user base exists).
Mobile/companion app. Plugin marketplace beyond the MCP catalog (the catalog IS the
plugin system).
