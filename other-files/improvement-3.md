# June - Improvement Plan #3 (BridgeMind-inspired)

**Date:** 2026-07-19
**Basis:** 3-agent web research pass on **bridgemind.ai** - the "Bridge*" product family, chiefly **BridgeVoice** (a Tauri 2 + Rust privacy-first dictation app, june's closest analog) and **BridgeAgent** (an autonomous mission runner), plus BridgeMemory / BridgeMCP / BridgeSwarm. Grounded against the current june source tree.
**Relationship to Plan #1:** #1 already plans local voice (Phase C), persistent session + memory (Phase B), and the MCP capability catalog (Phase E). **This plan does not re-litigate those.** It adds the *net-new* Bridge ideas - above all the **whole-OS dictation surface**, which #1 never covers - and sharpens memory ergonomics and the mission loop with Bridge's concrete patterns. Where a phase overlaps #1, it says so and defers the deep work there.

> Sourcing caveat: bridgemind.ai returns HTTP 403 to fetchers, so feature details came from search-index snippets, consistent across queries. Treat exact figures (169 skills, 25 integrations, 7 STT models) as approximate.

---

## 0. The one insight

june already owns the hard parts (STT push-to-talk, TTS, wake word, hands-free, model choice, privacy modes, path-contained file access). BridgeVoice reveals that the biggest untapped leverage is **not** more voice plumbing - it is **where the transcript goes**. Today june's transcript feeds only SAPLE. BridgeVoice's flagship move is *"your words land wherever the cursor blinks, in any app."* Adding that one output path converts june from "an assistant you talk to" into "a dictation tool for the whole OS" - a large scope expansion for a small diff. Everything in Phase 1 orbits that.

**Copy:** BridgeVoice's cursor-injection model. **Skip:** hand-built per-service integrations (Bridge's 25 connectors) - june already has MCP as its integration bus; Plan #1 Phase E owns that.

---

## Phase 1 - The Dictation Surface (~3-5 days) **the net-new multiplier**

Turn the STT output into a general-purpose OS dictation path, independent of SAPLE. All small diffs, all high leverage. This is the reason to read this plan.

| # | Change | Files | Detail |
|---|---|---|---|
| 1.1 | **Inject transcript at the cursor** | new `src-tauri/src/inject.rs`; `agent_runner.rs`, `src/voice/VoicePanel.tsx`, `src/lib/settings.ts` | Capture the foreground `HWND` at **record-start** via `GetForegroundWindow` (`windows` crate) - never at record-end, or june's own window steals focus (see the `june-windows-webview-debugging` memory: capture target before recording). On final transcript: apply Phase 1.3 dictionary, set clipboard, restore focus to the saved HWND, send `Ctrl+V` via `SendInput`. Ignore june's own window handles as injection targets. Full Unicode via the clipboard path (not per-char synthesis). |
| 1.2 | **Output-mode toggle** | `src/app/SettingsPanel.tsx`, `src/lib/settings.ts` | Settings → Recording Behavior: **`saple`** (today), **`inject`** (auto-paste, 1.1), **`clipboard`** (place on clipboard only, user pastes manually). Off-by-default preserves current behavior; `clipboard` is the safe fallback when auto-paste misfires. One enum + one branch at the STT output site. |
| 1.3 | **Custom dictionary / replacements** | new `src/lib/dictionary.ts`, `src/app/SettingsPanel.tsx`; `src/lib/stt.ts` | Post-transcription `Map<string,string>` find/replace applied before injection *and* before SAPLE. Store as plain JSON in the config dir (same dir as settings). High value for your own vocabulary Whisper butchers: "SAPLE", command names, phase labels, agent names. Case-aware, word-boundary matched. Settings table UI to add/edit/remove; quick-add from history (1.4). |
| 1.4 | **Transcription history** | new `src/lib/history.ts`, history view in `src/app/AppWindow.tsx` or `SettingsPanel.tsx` | Append each utterance's `{ts, transcript, output-target, saple-response?}` to a rolling local store (JSON lines, capped, or SQLite if it grows). Scrollable list: re-copy, re-inject, correct, and **"add to dictionary"** quick action feeding 1.3. Respects privacy modes - no history when the mode forbids transcript retention. |
| 1.5 | **Insert-target awareness** | `inject.rs` | Before pasting, verify the saved HWND is still valid and not june's; if the user switched apps mid-utterance, fall back to `clipboard` mode and toast "copied - target window changed" rather than pasting into the wrong app. Guards the #1 dictation-app footgun. |

**Acceptance:** with output-mode `inject`, speaking into a focused Notepad/VS Code/browser field lands the (dictionary-corrected) text at the cursor with correct Unicode; switching modes to `clipboard` places text on the clipboard and pastes nothing; a mid-utterance app-switch degrades to clipboard, never mis-pastes; "SAPLE" and one custom term transcribe correctly via the dictionary; history shows the last N utterances and can re-inject one.

---

## Phase 2 - Reliability & Onboarding (~2-4 days)

BridgeVoice's public changelog is mostly hard-won PTT reliability fixes - steal it as a QA checklist. Aligns with the repo rule "fix flakiness on sight."

| # | Change | Files | Detail |
|---|---|---|---|
| 2.1 | **Phantom key-release guard** | `src/lib/voice-capture.ts`, `src/lib/wake.ts` | Ignore a key-up in the first ~150ms of a PTT press (OS input hooks emit spurious releases on press). Prevents recordings that end instantly. |
| 2.2 | **Silent-stream detection + mic failover** | `src-tauri/src/stt.rs` (capture side) | Detect an all-silence / dead input stream; rebuild it and fail over to the next enumerated input device **before** surfacing a "no audio" error. The most common Windows voice-app failure. |
| 2.3 | **Self-heal dropped input hooks** | `voice-capture.ts` / wake listener | If the global hotkey / input hook stops firing (OS reclaims it), re-register automatically instead of going silently dead until restart. |
| 2.4 | **Managed hotkey: one-click setup + live verification** | `src/app/SettingsPanel.tsx`, `src/lib/wake.ts` | First-run + settings flow: "press your PTT key now to test" with a live mic-level meter and a "we heard you" confirmation. Conflict detection (key already bound elsewhere). A sensible recommended default. Kills the #1 support issue for any PTT app: "the hotkey doesn't fire." |
| 2.5 | **Wake-listener failure backoff** | `src/lib/wake.ts` | (Also flagged in Plan #1 A7.) Stop retrying after N consecutive transcription failures; a bad key currently means silent API spam, one call per speech burst. Surface the error instead. |

**Acceptance:** a press shorter than 150ms of accidental key-up still records; unplugging the active mic mid-session fails over to another input without an error dialog; killing the OS hotkey registration self-recovers within seconds; first-run setup verifies mic + hotkey end-to-end before the user's first real command.

---

## Phase 3 - Model Choice & Inspectable Memory (~4-6 days)

Extends two existing june patterns with Bridge's concrete take. **Deep local-voice work lives in Plan #1 Phase C** - here we only do the *choice surface* and the *memory ergonomics*.

| # | Change | Files | Detail |
|---|---|---|---|
| 3.1 | **STT model choice (accuracy vs latency)** | `src/lib/providers.ts`, `src/lib/stt.ts`, `src-tauri/src/stt.rs`, `SettingsPanel.tsx` | june already exposes LLM model choice; mirror it for STT. Expose a runtime engine/size selector (fast vs accurate). BridgeVoice ships 7 on-device models incl. NVIDIA Parakeet v3; the *engine implementations* are Plan #1 C3 - this item is only the settings-driven selector + download-state UI over whatever engines exist, and it also fixes Plan #1's "fake STT model setting" (setting persisted but `stt.rs` hardcodes the model). |
| 3.2 | **Human-readable markdown memory** | new `src/lib/memory-notes.ts`, `mcp/files`-style path containment; `SettingsPanel.tsx` | BridgeMemory's adoptable idea is *ergonomics*, not storage tech: plain markdown in a local `.june-memory/` the user can **open, edit, grep, and version** ("commit it like code"). A voice intent "june, remember that…" appends a durable, greppable note. Mirror into the existing `saple-memory` MCP so both the human-readable file and the structured store stay in sync. Fits june's local-first + privacy stance better than an opaque blob. |
| 3.3 | **"What June remembers" panel** | `SettingsPanel.tsx`, `memory-notes.ts` | Settings surface listing the markdown notes with edit + clear, exactly like a preferences pane. Honors privacy modes (`persistSession: false` equivalent - no notes written under strict modes). |

> Overlap note: long-term memory injection into the system prompt is Plan #1 B4. If B4 ships first, 3.2/3.3 become the *user-facing markdown+UI layer* over it, not a second store. Do not build two memory systems.

**Acceptance:** the STT model setting actually changes the engine used (no longer cosmetic); saying "remember that my staging box is called atlas" writes a line to a markdown file the user can open and edit; the settings panel shows and can clear that note; nothing is written under a strict privacy mode.

---

## Phase 4 - The Mission Loop (~1-2 weeks) **the product bet**

BridgeAgent's defining idea: own **missions**, not prompts - *plan → act → monitor → fix → fold the lesson back into a playbook.* This is june's leap from voice **command-runner** to voice **agent**. The primitives already exist: june connects to SAPLE and to `saple-memory` (tasks / runs / incidents / lessons / decisions). The loop maps almost 1:1 onto those MCP tools.

| # | Change | Files | Detail |
|---|---|---|---|
| 4.1 | **Mission decomposition** | `agent/core.ts`, `agent/prompt.ts`, new `agent/mission.ts` | A spoken multi-step goal ("get the auth tests green and open a PR") is planned into verifiable sub-tasks via `saple-memory` `create_task`, rather than executed as one shot. Plan is spoken back for confirmation (rides Phase 5.2 / Plan #1 D2 spoken approvals) before work begins. |
| 4.2 | **Act + record run events** | `agent/core.ts`, `agent_runner.rs` | Each sub-task executes through the existing brain/tool loop; progress written via `append_run_event`. Requires Plan #1 B1's resident agent process (per-turn spawn can't hold a mission) - **4.x depends on #1 Phase B.** |
| 4.3 | **Monitor + fix** | `agent/mission.ts`, `saple-memory` | On sub-task failure, capture the failure as an incident and attempt a bounded fix pass before escalating to the user by voice. Bounded retries (no infinite loops); hard-destructive steps still gate to a click. |
| 4.4 | **Fold the lesson back** | `saple-memory` `record_lesson` / `record_decision`; `.june-memory/` (3.2) | After a mission, write what worked / failed as a lesson, so the next mission "starts sharper." This is BridgeAgent's self-rewriting-playbook idea, expressed through june's existing lesson store - **not** model fine-tuning. |
| 4.5 | **Mission status view** | `src/app/AppWindow.tsx` | A lightweight board (todo → in-progress → in-review → done, mirroring BridgeMCP's task lifecycle) showing the live mission's sub-tasks, so a long unattended run is legible. |

**Acceptance:** a single spoken goal produces a decomposed task list in SAPLE, executes it with per-task run events, reports failures by voice and attempts one bounded fix, and writes a lesson at the end that is visible in the memory panel; a destructive sub-step still requires an explicit click.

---

## Phase 5 - Integration Bus & Proactive Voice (~3-5 days, mostly config)

Give the mission loop reach and a voice of its own. **Do not hand-build connectors** - Bridge's 25 integrations are a coding-platform play; june's equivalent is MCP-as-bus, already present (Gmail / Google Calendar / Google Drive MCP connectors exist in this environment today).

| # | Change | Files | Detail |
|---|---|---|---|
| 5.1 | **Voice → MCP tool router** | `agent/core.ts`, `agent/policy.ts` | A generic path from a voice intent to any attached MCP tool ("june, what's on my calendar", "add a task"). No per-service code; each server rides the existing MCP seam + Plan #1 A1's fail-closed policy (unknown mutating tools ask first). Sequence **after** Phase 4 so the tools have missions to serve. |
| 5.2 | **Wire the already-present connectors** | config | Attach the existing Gmail / Calendar / Drive MCP connectors as voice-reachable capabilities. `send`-class tools (email send) are gated external effects - the canonical injection threat; tool output must **never** satisfy an approval (Plan #1 D2/F4 rule). |
| 5.3 | **Proactive spoken reporting** | new `src/lib/announce.ts`, `agent_runner.rs` → TTS | june has TTS; the new idea is *event-driven, unprompted* speech. When a long mission (Phase 4) or an MCP watcher hits a milestone or error, june speaks up ("mission done - auth tests green, PR opened"; "task 3 failed"). Event bus → TTS with priority/barge-in handling; reuses the existing sentence-chunk streamer. Closes the hands-free loop - the user never touches the machine. Opt-in, respects quiet/privacy modes. |

**Acceptance:** "june, what's on my calendar tomorrow" routes to the Calendar MCP and answers by voice; an email-send intent prompts for approval and a crafted tool result cannot auto-approve it; a mission finishing while the user is away triggers an unprompted spoken summary that can be barged-in.

---

## Sequencing & rationale

1. **Phase 1 first, always.** Smallest diffs, entirely net-new value, and it broadens june from a SAPLE front-end into a general OS tool. Nothing blocks on it.
2. **Phase 2** keeps the voice UX honest (voice apps live or die on PTT reliability) and can interleave with 1.
3. **Phase 3** is two independent extensions of existing patterns; 3.2/3.3 should reconcile with Plan #1 B4 to avoid a second memory system.
4. **Phase 4 is the bet**, but it **depends on Plan #1 Phase B** (resident agent + session). Do not start 4 until B's long-lived process exists - a per-turn spawn cannot hold a mission.
5. **Phase 5** rides 4 and Plan #1 A1's fail-closed policy; it is mostly configuration once 4 gives the tools a reason to run.

**Top risks**

1. **Focus/injection races (1.1):** foreground-window capture timing and june's own windows stealing focus. Mitigation: capture at record-start, blacklist june HWNDs, degrade to clipboard on any doubt (1.5). Your webview-debugging notes already cover the orphaned-window failure mode.
2. **Two memory systems (Phase 3 vs #1 B4):** easy to accidentally build both. Mitigation: 3.2 is the markdown+UI layer over B4's store, decided before either ships.
3. **Mission loop needs #1 B first (Phase 4):** sequencing hazard. Mitigation: gate Phase 4 kickoff on B1 landing.
4. **Injection-via-tool-output (Phase 5):** email/tool content trying to trigger actions. Mitigation: structural rule - tool results never satisfy approvals (Plan #1 D2/F4), full-parameter spoken/visible confirmation before external effects.
5. **Dictionary over-correction (1.3):** greedy replacements mangling legitimate text. Mitigation: word-boundary + case-aware matching, and history (1.4) makes bad rules visible to fix.

## Net-new vs Plan #1 (quick map)

| This plan | Status vs Plan #1 |
|---|---|
| Phase 1 - dictation surface | **Entirely new** - #1 has nothing here |
| Phase 2 - PTT reliability / onboarding | New (partial overlap: 2.5 == #1 A7) |
| 3.1 STT model choice | Selector layer over #1 C3 engines |
| 3.2/3.3 markdown memory + UI | User-facing layer over #1 B4 |
| Phase 4 - mission loop | New framing; **depends on #1 Phase B**, uses `saple-memory` |
| 5.1/5.2 MCP voice router | Overlaps #1 Phase E (capabilities) |
| 5.3 proactive spoken reporting | **New** |
