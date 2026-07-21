# June deep-dive review findings

## Executive verdict

June is ambitious and surprisingly mature for a `0.1.0` application. The underlying engineering is strongest around agent-process supervision, approval gating, privacy modes, bounded persistence, and automated tests.

The main weaknesses are concentrated at trust boundaries and product cohesion:

- Several "local-first" safety guarantees can currently be weakened through configuration or filesystem indirection.
- Interactive chat, missions, and unattended automation are too tightly coupled to one resident conversation.
- Settings persistence has a few race and silent-failure paths.
- The interface has solid foundations but needs an accessibility, responsive-layout, and information-architecture pass.
- The repository contains substantial implementation-history noise, while its public documentation is badly outdated.

I found no P0 release-blocking issue, but I would address the first six findings before calling unattended automation production-ready.

## Priority findings

### P1 — Major

#### 1. The scoped-files capability can escape its configured root through symlinks or junctions

Reading a file checks its real path, but listing a directory does not. Writing validates the parent directory rather than the existing target, so an in-root symlink can redirect a write outside the approved root.

Evidence: `mcp/files/server.ts:74`.

Improvement: validate the real path for listed directories and existing write targets, and use a no-follow/open strategy to reduce check-then-use races.

#### 2. Interactive, mission, and unattended work share too much conversation state

The code explicitly notes that scheduled runs use the same resident and may pollute the transcript; it currently accepts that as rare. Mission planning also calls `newConversation()`, silently discarding the user's interactive context.

Evidence: `src-tauri/src/agent_runner.rs:1170` and `src/app/MissionBoard.tsx:38`.

Improvement: separate resident/session lanes for interactive chat, mission planning, mission execution, and unattended runs. At minimum, run each unattended job in a clean temporary conversation.

#### 3. A server-wide "Observe" classification is a broad trust downgrade

The settings UI promises "read-only, auto-run," but the runtime applies the selected default to every otherwise-unclassified tool on that server. A changed, compromised, or incorrectly described server could introduce a mutating tool that is automatically treated as safe.

Evidence: `src/app/SettingsPanel.tsx:1296` and `agent/policy.ts:172`.

Improvement: classify individual tool names, retain "unknown means gated," and invalidate approvals when the discovered tool inventory changes.

#### 4. Strict Offline relies on a user-editable assertion rather than the transport

Any server—including an HTTP server—can be marked "Offline-safe." Strict Offline then permits it solely from that flag.

Evidence: `src/lib/mcp-servers.ts:128` and `src/app/SettingsPanel.tsx:1460`.

Improvement: never permit HTTP transport under Strict Offline. Present stdio's `offlineSafe` as an explicit trust override because a local process may still access the network.

#### 5. Custom MCP credentials are stored in plaintext settings

Environment variables and HTTP headers—including examples containing access tokens and authorization headers—are written into `settings.json`. Provider API keys already have the better OS-keychain design.

Evidence: `src/app/SettingsPanel.tsx:1304`.

Improvement: store secrets in the keychain and leave opaque references in server configuration. Redact them from logs, exports, diagnostics, and UI summaries.

#### 6. Settings synchronization remains racy across processes

Rust serializes its own updates, but the automation MCP is a separate process with a separate mutex. Both can perform whole-file read-modify-write cycles; an automation edit landing in the wrong window can be lost. The limitation is acknowledged in the source.

Evidence: `src-tauri/src/settings.rs:8`.

Improvement: make the Tauri host the sole settings writer, or introduce a genuine inter-process lock/versioned compare-and-swap store.

#### 7. Settings read failures are silently converted into valid defaults

`loadSettings()` catches every backend error and returns `{}`, which is coerced to defaults. A transient I/O problem therefore looks like a fresh configuration; a later save can overwrite legitimate settings.

Evidence: `src/lib/settings.ts:257`.

Improvement: distinguish "file absent," "invalid/corrupt," and "backend unavailable." Block writes when loading failed and offer recovery from the original file.

#### 8. MCP command arguments cannot safely represent spaces

Arguments are displayed with `join(" ")` and parsed with whitespace splitting. Windows paths, JSON arguments, quoted values, and prompts containing spaces cannot round-trip.

Evidence: `src/app/SettingsPanel.tsx:1418`.

Improvement: use one argument per line or a JSON-array editor. This is simpler and unambiguous.

#### 9. The primary voice control is not keyboard-operable

The orb is a `<button>`, but its behavior is implemented through pointer-down/up handlers without a click or equivalent keyboard interaction. Enter and Space therefore do not activate its principal behavior.

Evidence: `src/voice/VoicePanel.tsx:1029`.

#### 10. The onboarding dialog lacks modal keyboard behavior

It declares `role="dialog"` and `aria-modal="true"` but does not visibly provide initial focus, focus containment, Escape dismissal, focus restoration, or an inert background.

Evidence: `src/app/AppWindow.tsx:402`.

#### 11. Many advanced settings controls lack programmatic labels

The MCP transport, command, arguments, environment, headers, URL, tool class, file root, and several automation fields use adjacent `<span>` text or placeholders instead of associated labels.

Representative evidence: `src/app/SettingsPanel.tsx:1397`.

#### 12. The full-window layout is not designed for its supported minimum width

The Tauri window permits 560px width, but the header and four-item navigation do not wrap or collapse, the body hides overflow, and there are no width-based media queries. Clipping is likely at the minimum size.

Evidence: `src/styles.css:624`.

### P2 — Important

#### 13. API-key failures have no local error state

Save and clear operations use `try/finally` without `catch`, leaving rejected keychain operations as unhandled UI promises.

Evidence: `src/app/SettingsPanel.tsx:649`.

#### 14. Destructive settings actions lack undo

Removing MCP servers, schedules, triggers, and watch loops happens immediately. The application already uses two-step confirmation for clearing recorded activity, but not for these frequent settings actions. A short undo toast would be less disruptive than confirmation modals.

#### 15. Activity retention is underspecified

Standard privacy mode keeps prompts, replies, and tool audit parameters in local run logs. Rotation controls file size, not time or sensitivity. Consider retention duration, export visibility, onboarding disclosure, and field-level secret redaction.

#### 16. Repository quality gates are red despite the main tests passing

`npm run lint` fails because generated sidecar bundles under `src-tauri/resources` are included even though the directory is ignored by Git. The ignore list in `eslint.config.js:11` does not include it. `npm run format:check` reports 45 unformatted files.

#### 17. The README describes a completely different application

It still says June is an empty Phase 0 window with no voice, agent loop, or capabilities.

Evidence: `README.md:6`.

This damages onboarding, maintainability, and contributor confidence.

#### 18. Three files carry disproportionate responsibility

- `src/app/SettingsPanel.tsx`: 1,961 lines.
- `src/voice/VoicePanel.tsx`: 1,325 lines.
- `src-tauri/src/agent_runner.rs`: 1,800 lines.

This is not merely a style concern: each combines several independently testable state machines and failure modes. Use existing domain boundaries—capture, turn execution, playback, process supervision, and audit persistence—not generic utility layers.

#### 19. Cross-language configuration contracts can drift

Provider compatibility, privacy behavior, automation keys, settings defaults, and persistence shapes are repeated between TypeScript and Rust. Comments such as "keep in step" are warning signs. A shared serialized contract or cross-language fixture tests would provide stronger protection.

#### 20. The settings experience is visually and cognitively dense

Twelve sections, a wrapping sticky chip navigation, repeated bordered cards, nested configuration panels, and many small uppercase headings make the page feel like an implementation console. Grouping into "Voice," "Intelligence," "Capabilities," "Automation," "Privacy," and "System" would make it easier to scan.

#### 21. Some interface feedback is too quiet

"No mission yet" provides no suggested next action, several asynchronous test results are not live regions, and capability status relies heavily on color dots or `title` text.

### P3 — Polish

#### 22. Two rapidly updated meters animate layout properties

The waveform transitions `height`, and the microphone meter transitions `width`. Both are updated frequently and should use compositor-friendly transforms.

Evidence: `src/styles.css:345` and `src/styles.css:1138`.

#### 23. Reduced-motion coverage is incomplete

Most important animation is disabled correctly, but the onboarding backdrop's entrance animation is outside that coverage.

#### 24. An undefined token is used

`.app-flash` references `--text-dim`, while the defined token appears to be `--dim`.

Evidence: `src/styles.css:824`.

#### 25. The visual identity leans on familiar "AI assistant" conventions

Blue/violet gradients, glowing orb states, large shadowed cards, pill navigation, and repeated translucent panels are coherent but generic. The two-face concept is the more distinctive product idea; the design should derive more strongly from that instead of category-default gradients.

## Complexity audit

The clearest over-engineering and repository-hygiene opportunities are:

- `[shrink]` Remove implementation-history comments such as `improvement-5 P1.5`, past bug narratives, and phase references from production source; preserve only current invariants and rationale.
- `[shrink]` Consolidate repeated TypeScript/Rust configuration definitions behind contract fixtures.
- `[yagni]` Archive or remove obsolete root-level planning artifacts once their surviving decisions are documented.
- `[native]` Prefer native dialog/focus behavior and unambiguous line-based argument editing over custom interaction logic.
- `[delete]` Stop linting generated resources, since they are already Git-ignored and are not maintainable source.

A credible cleanup is roughly **400–700 source lines and zero dependencies**, mostly comment archaeology and duplicated contract logic. Splitting large modules would improve ownership but should not be counted as a line reduction.

## Verification

- TypeScript type checking: passed.
- Vitest: **302 tests across 37 files passed**.
- Rust: **52 tests passed**.
- Rust Clippy with warnings denied: passed.
- ESLint: failed on generated sidecar bundles.
- Prettier check: failed on 45 files.
- No source files were modified during the review.
- A live rendered UI inspection was not possible because the in-app browser was unavailable, so responsive and visual-polish observations are source-inferred.

## UI scorecard

| Area | Score | Assessment |
|---|---:|---|
| Accessibility | 2/4 | Good focus styles and some live/error semantics, but major keyboard, modal, and form-label gaps |
| Performance | 3/4 | Sensible caps, lazy loading, resident process, and reduced-motion support; minor layout-animation issues |
| Responsive design | 2/4 | Desktop-appropriate structure, but no width breakpoints despite a 560px minimum |
| Theming | 3/4 | Consistent dark tokens; a few invalid/hardcoded values and only one visual theme |
| Anti-pattern avoidance | 2/4 | Coherent, but card-heavy and strongly category-generic |
| **Total** | **12/20** | Solid foundation with significant polish and accessibility work remaining |

## Recommended order

1. Close the files-MCP containment gaps.
2. Isolate interactive, mission, and unattended sessions.
3. Harden MCP classification, Strict Offline, and secret storage.
4. Make settings persistence failure-aware and cross-process safe.
5. Fix keyboard operation, modal focus, labels, and the 560px layout.
6. Restore lint/format gates and update the README.
7. Simplify Settings and remove implementation-history noise.
8. Finish visual identity, animation, and empty-state polish.

Re-run `$impeccable audit` after fixes to see the score improve. Since there is no `PRODUCT.md`, `$impeccable init` would also help turn the intended experience into explicit design criteria.
