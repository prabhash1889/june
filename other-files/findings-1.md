# June Application - Deep Review Findings

## Executive Summary

June is an impressively well-architected local-first voice agent. The codebase shows disciplined layered design with clear separation of concerns, strong security posture, and thoughtful privacy-by-default. That said, there are meaningful areas for improvement across code quality, UX polish, error resilience, and architectural refinement.

---

## 1. Architecture & Design

### Strengths
- **Excellent MCP extensibility model** - "a capability is a server, not a plugin system" is executed cleanly. Adding servers requires zero core changes.
- **Privacy tiers are honest and enforceable** - enforcement runs at execution time, not just in the UI form, so editing `settings.json` can't bypass a mode.
- **Approval gate lives in the execution layer, not the brain** - swapping models can never skip safety checks.
- **Resident agent process** eliminates per-turn MCP reconnection overhead.

### Findings

**1.1 - The `AGENT.md` / `PLAN.md` divergence risk.** `PLAN.md` is 60KB and appears to be the canonical design document. However, `README.md` says "Phase 0 (foundations) complete - an empty Tauri window" while the code is well past Phase 9. The README is stale and could mislead new contributors or reviewers.

**1.2 - Monolithic VoicePanel (1327 lines).** `src/voice/VoicePanel.tsx` is the largest file in the codebase at ~1327 lines with deeply nested state machines, refs, and effects. It handles capture, transcription, review, agent dispatch, TTS playback, barge-in, wake word, mission state, approval, dictation, quick-capture, and widget geometry. This is the highest-risk file for regressions and the hardest to reason about. It would benefit from decomposition into smaller hooks (e.g., `useCapturePipeline`, `useSpeechPlayback`, `useApprovalFlow`).

**1.3 - Duplicate type definitions between frontend and backend.** `SafetyClass` in `agent/policy.ts` and `McpClass` in `src/lib/mcp-servers.ts` are structurally identical but kept separate with a comment saying "no cross-import so the frontend never pulls in the agent module." This is intentional but fragile - a drift between them would silently break the safety model. Consider a shared schema definition or at minimum a contract test that asserts structural equivalence.

**1.4 - Turn-number space complexity.** The turn-number allocation uses epoch-based seeding with three bands (interactive < mission < unattended) and careful bit-width management. The comments explain the rationale well, but this is a latent correctness risk if the codebase evolves. The comment about widening the epoch in 2037 is pragmatic, but a type-safe wrapper or domain-specific number type would prevent accidental misuse.

---

## 2. Error Handling & Resilience

### Findings

**2.1 - Silent `.catch(() => {})` proliferation.** Multiple places swallow errors silently:
- `errorlog.ts`: `invoke("log_message", ...).catch(() => {})`
- `session.ts`: `invoke<SessionEvent[]>("session_events").then(...).catch(() => {})`
- `core.ts`: various `fs.readFile(...).catch(() => undefined)`

While some of these are intentional (best-effort logging, graceful degradation), the pattern is overused and makes debugging harder. Some of these should at minimum `console.debug` so developers can trace issues in dev mode.

**2.2 - ErrorBoundary is minimal.** The `ErrorBoundary` component shows "June hit a display error" with a Reload button. For a voice agent, this is a harsh recovery path - the user may be mid-conversation, mid-approval, or hands-free. Consider: (a) attempting to preserve the current approval state across reload, (b) a more graceful fallback UI that at least shows the last conversation state, (c) logging the error to the tray notification system so the user knows what happened.

**2.3 - The `capture.current` guard ref pattern.** `VoicePanel` has multiple ref guards (`openingMic`, `stopping`, `releaseDuringSetup`) to prevent race conditions in the capture lifecycle. These are well-commented but represent a fragile concurrency model built on manual ref juggling. A state machine library (e.g., XState) or at least a consolidated capture state object would make the lifecycle more predictable.

**2.4 - No retry/backoff for brain calls.** If the brain API call fails (rate limit, network blip), the turn immediately reports failure. For transient errors, a single retry with exponential backoff would improve perceived reliability without adding complexity.

---

## 3. Security & Privacy

### Strengths
- Path containment for the files capability is thorough (realpath checks, symlink escape prevention).
- API keys never cross the IPC boundary.
- Scrubbed environment for MCP server children.
- Unattended runs have reduced capability sets.

### Findings

**3.1 - The `scrubbedEnv` function is critical but its implementation is not visible in the reviewed files.** The security model depends on it correctly nulling sensitive keys. Consider adding a unit test that asserts all known sensitive env vars are scrubbed, and that the function handles edge cases (undefined values, nested objects, etc.).

**3.2 - `write_file` in the files MCP server allows parent directory creation (`mkdir recursive`).** While the path is resolved within the allowed root, recursive directory creation could be used to create deeply nested structures that fill disk. Consider a depth limit or at least logging.

**3.3 - The `UNATTENDED_BLOCKED_OBSERVE` set blocks `read_clipboard` on unattended runs but not `write_clipboard`.** This is correct (writing clipboard can't exfiltrate), but the asymmetry should be documented more prominently since it's a subtle security property.

**3.4 - No rate limiting on the approval gate.** A malicious or buggy brain could flood the approval queue with gated actions. Consider a cap on pending approvals per turn.

---

## 4. UX & Polish

### Findings

**4.1 - The review gate adds latency to every voice command.** The user speaks, sees the transcript, then must explicitly accept. For trivial commands ("what time is it"), this is friction. Consider a confidence-based auto-accept for short, low-risk observe-class commands when hands-free mode is enabled.

**4.2 - Error messages are technically accurate but not always actionable.** For example, "June hit an error: ..." in the final turn text doesn't tell the user what to do next. The error taxonomy in `voice-capture.ts` (`CaptureError`) is a good model - extend this pattern to agent errors and brain errors so the UI can show "check your API key" vs "try again later" vs "June doesn't support that."

**4.3 - The widget's `onActiveChange` callback for geometry is a leaky abstraction.** The widget shell needs to know the card's content height to size the window, but VoicePanel computes this internally. The current approach (callback with pixel height) works but creates a tight coupling between the shell and panel. A more formal layout contract (CSS container queries or a shared layout context) would be cleaner.

**4.4 - No loading skeleton or progress indication during model downloads.** The `modelDownload` state is tracked but the UI treatment is minimal. First-run downloads of Moonshine/Kokoro models could take minutes - a progress bar with "Downloading Moonshine... 45%" would be much better than a status line.

**4.5 - The "need-key" phase in VoicePanel shows a setup prompt but doesn't guide the user through key entry.** It would be better UX to inline the key entry form (or open the settings panel directly to the API keys section) rather than just telling the user to go find it.

---

## 5. Testing

### Findings

**5.1 - Test coverage appears good for core logic** (policy, protocol, MCP servers, settings coercion, transcript cleaning, etc.), but the voice pipeline tests are necessarily thin due to real-audio dependencies. The codebase acknowledges this in PLAN.md as a known risk.

**5.2 - No integration tests for the full voice-to-voice path.** Even with mocked audio, an integration test that: captures audio -> transcribes -> runs agent -> synthesizes -> verifies playback would catch regression in the pipeline wiring. The `SentenceBuffer` tests are good but don't verify the end-to-end flow.

**5.3 - The `ApprovalHub` and `gate` mechanism would benefit from a concurrency test.** Specifically: two turns arriving rapidly, the first being preempted, and verifying that the first turn's pending approval is properly denied while the second turn's gate works correctly.

**5.4 - No fuzz testing for the coercion functions.** `coerceMcpServers`, `coerceEntry`, `coerceSchedules`, etc. handle arbitrary JSON from settings files. A fuzz test that feeds malformed JSON and asserts no crashes would catch edge cases.

---

## 6. Code Quality & Maintainability

### Findings

**6.1 - The "ponytail" comments are a useful convention** for marking temporary/acceptable technical debt, but there's no tracking mechanism. Consider a lint rule or grep-able marker (e.g., `TODO:`) so these can be periodically reviewed.

**6.2 - Magic numbers are well-commented but still magic.** Constants like `APPROVAL_TIMEOUT_MS = 120_000`, `MAX_CAPTURE_MS = 15_000`, `AUTO_ACCEPT_SECONDS = 2`, etc. are scattered across files. Grouping these into a single constants module (or at least co-locating related constants) would improve discoverability.

**6.3 - The `scrubbedEnv` usage pattern is repeated verbatim** in `core.ts` for every MCP server configuration. The comment explaining why (`ENAMETOOLONG` avoidance + secret scrubbing) is excellent, but the pattern should be a utility function rather than repeated inline.

**6.4 - The `useConversation` hook in `AppWindow.tsx` is 150+ lines** and handles replay, live events, deduplication, and buffering. This is complex but well-structured. Consider extracting the replay/buffer logic into a separate hook for testability.

**6.5 - The `boundary()` function in `tts.ts` for sentence splitting uses a simple heuristic** (`.`, `!`, `?`, newline). The comment acknowledges this is acceptable for June's prompt style, but it will silently mis-split if the prompt conventions change. A more robust approach would be to use a proper sentence tokenizer (even a simple regex with negative lookbehind for abbreviations).

---

## 7. Performance

### Findings

**7.1 - The `SentenceBuffer` flushes on each delta** which is correct for streaming, but the `boundary()` function scans the entire buffer on every push. For very long replies (unlikely but possible), this is O(n^2). Not a practical concern now, but worth noting.

**7.2 - The `cannedCache` in `tts.ts` is unbounded** (it's a `Map` with no eviction). In practice it's small (4 phrases), but the design comment says "never cache a failed synthesis" which is good. Consider adding a max-size guard or LRU eviction for defensive coding.

**7.3 - The `active.current` Set in `useConversation` is cleared on every mount** due to StrictMode double-mount. This is correct but the comment explaining why is buried. A code reviewer unfamiliar with React StrictMode behavior might try to "optimize" this.

---

## 8. Documentation

### Findings

**8.1 - The inline documentation is exceptional.** Almost every function, class, and non-trivial block has a comment explaining the "why" not just the "what." The PLAN.md references are traceable. This is a significant strength.

**8.2 - The README is severely outdated.** It describes the project as "Phase 0 (foundations) complete - an empty Tauri window with tray presence and a persisted settings store. No voice, no agent loop, no capabilities yet." This is misleading - the codebase has voice, agent loop, multiple capabilities, widget/app dual-face, and more. Update the README to reflect current state.

**8.3 - The `bugs1.md` file (24KB) appears to be a running bug log.** Consider converting this to GitHub Issues for better tracking and resolution visibility.

---

## 9. Summary of Top Priorities

| Priority | Finding | Impact |
|----------|---------|--------|
| **High** | VoicePanel decomposition (1.2) | Maintainability, regression risk |
| **High** | README staleness (8.2) | Contributor experience, onboarding |
| **High** | Silent error swallowing (2.1) | Debuggability |
| **Medium** | ErrorBoundary recovery UX (2.2) | User experience |
| **Medium** | Retry/backoff for brain calls (2.4) | Perceived reliability |
| **Medium** | Type drift risk between SafetyClass/McpClass (1.3) | Safety correctness |
| **Medium** | Approval queue flooding (3.4) | Security |
| **Low** | Magic number consolidation (6.2) | Code navigation |
| **Low** | Fuzz testing for coercion functions (5.4) | Edge case resilience |
| **Low** | Model download progress UX (4.4) | First-run experience |

---

## Overall Assessment

June is a high-quality, well-designed application. The security model is thoughtfully layered, the architecture is extensible, and the codebase documentation is above average. The main areas for improvement are: (1) the VoicePanel monolith needs decomposition, (2) error handling needs to be more consistent and user-facing, (3) the README needs updating, and (4) a few security hardening items should be addressed. The codebase is in good shape for continued development.
