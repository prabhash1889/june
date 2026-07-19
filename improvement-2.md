# June Improvement Plan v2 (Phases 10-19)

North star: june is a **general local-first voice agent**. saple-bridge becomes one optional
capability among many, not the core. Every new capability is an MCP server, every action still
routes through the policy gate (`agent/policy.ts`), every feature respects privacy modes.

Prereq: the Phase 9 hardening tail in PLAN.md (sidecar bundling, recovery drills, logs,
installer) stays open and runs in parallel; nothing below depends on it except Phase 15/17
(headless runs need the bundled sidecar).

---

## Now

### Phase 10 - Local voice stack
Goal: Local-voice and Strict-offline modes become real instead of "mic off".
- STT: whisper.cpp via `whisper-rs` behind the existing `SttProvider` trait; model-size picker
  (tiny -> large-v3) with download-on-demand, checksum, progress UI.
- VAD: Silero ONNX replaces energy VAD in `src/lib/voice-capture.ts`.
- Wake word: openWakeWord ONNX "hey june" replaces STT-gated phrase spotting.
- TTS: Kokoro local voice behind the existing TTS provider seam.
- Flip `offlineSafe: true` on the new providers; privacy-mode enforcement already exists.

Exit: full voice turn (wake -> STT -> brain via Ollama -> TTS) with network disabled.

### Phase 11 - Transcript quality
Goal: dictation output feels professionally edited.
- Auto-edit pass: cheap LLM pass (selected brain, local-capable) strips filler, fixes
  punctuation, formats lists - runs before the existing transcript-review gate; settings toggle.
- Personal dictionary: corrections made in the review gate auto-add terms; dictionary biases
  the STT prompt and the edit pass; persists in june's data dir.
- Voice snippets: spoken cue expands to saved text ("insert my intro").

Exit: dictate a messy paragraph -> clean text; a corrected name sticks next session.

### Phase 12 - Generic MCP client
Goal: users add capabilities without june shipping them. Key decoupling step.
- Settings UI: add any MCP server (stdio command or URL), per-server enable toggle,
  per-server `offlineSafe` flag feeding privacy-mode enforcement.
- Policy: tools from unknown servers default to approval-required; user can promote a
  specific tool to auto-run after seeing it.
- `saple-bridge-control` and `mcp/files` become just the first two entries in this list.

Exit: add a GitHub MCP server from settings, list issues by voice, gate fires on a write.

---

## Next

### Phase 13 - Skills and memory (BridgeAgent's recursive trick)
Goal: june gets better at repeated tasks.
- Post-run lesson writer: agent appends a short markdown lesson file after each run.
- Pre-run recall: top-k relevant lessons injected into the system prompt.
- Wire saple-memory MCP as an optional server via Phase 12 machinery (config entry, no code).

Exit: the same task done twice uses prior lessons the second time.

### Phase 14 - Screen context grounding
Goal: "what does this error on my screen mean" just works.
- Opt-in observe-class tool: screenshot of active window + OCR (Windows.Media.Ocr, local).
- Privacy: local OCR only in Strict offline; screenshots never persisted to logs.

Exit: point at an on-screen error dialog, ask about it by voice, get a grounded answer.

### Phase 15 - Scheduled runs
Goal: june works while you don't.
- Rust local scheduler (cron expressions) launches headless agent sessions via the bundled
  sidecar; results land in the session log; OS notification on completion.
- Approval-required actions pause the run and notify - never auto-approve.

Exit: a daily 9am briefing run completes unattended and notifies.

### Phase 16 - System-wide dictation
Goal: june is useful even when the agent isn't needed.
- Dictation mode: PTT injects the cleaned transcript into whatever app has focus
  (SendInput/enigo), reusing Phase 11's edit pass.
- App-aware formatting: read focused window title to pick tone (Slack casual, email formal).

Exit: dictate into Notepad and a browser text field.

---

## Later

### Phase 17 - Watch loops
Goal: external signals become june investigations (the BridgeAgent production-watch pattern,
generalized beyond coding).
- Trigger framework: file-watch, localhost webhook receiver, log tail.
- A trigger opens an investigation task: fresh agent session with the trigger payload as
  context; e.g. Sentry webhook -> root-cause session. All actions still gated.

### Phase 18 - Missions
Goal: outcome-level tasking, not prompt-level.
- Mission = user-stated outcome; agent decomposes into a verifiable task list, runs
  sequential sessions per task, reports progress in a simple task-board UI.
- Composable toolsets: only mission-relevant MCP servers are loaded per session to keep
  context lean (BridgeAgent's 57-toolsets idea).

### Phase 19 - General agent platform
Goal: june stands alone.
- Computer-use MCP server, opt-in: screenshot / click / type tools, destructive-class by
  default in the policy gate.
- Zero saple-* dependencies required to run; saple-bridge is an optional MCP entry.
- Standalone installer + auto-update (finishes the Phase 9 tail); plugin surface is MCP only.

---

## Deliberately not doing
- Cloud-side execution ("runs with laptop closed") - against local-first.
- Stealth/undetectable overlays (Cluely-style) - against honest-by-design.
- Session-wide blanket approvals - per-action gating stays.
