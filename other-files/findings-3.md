# Deepdive Review: June Application

## Overall Assessment
**High-quality, well-engineered codebase** with sound architecture, multi-layered security, and exceptional documentation. The app is a local-first voice agent desktop built with **Tauri v2 + React 19 + TypeScript**.

---

## HIGH PRIORITY (Fix First)

| # | Issue | Location |
|---|-------|----------|
| 1 | **CSS variable bug**: `.app-flash` references undefined `--text-dim` (should be `--dim`) | `src/styles.css:824` |
| 2 | **Missing ARIA tab pattern** on tab navigation (no `role="tablist"`, `role="tab"`, `aria-selected`) | `src/app/AppWindow.tsx:307-311` |
| 3 | **Onboarding dialog lacks focus trap** - keyboard users can Tab out into hidden app | `src/app/AppWindow.tsx:380-428` |
| 4 | **README is severely outdated** - claims "Phase 0, empty window" when app is fully built | `README.md:6-8` |
| 5 | **No `cargo fmt --check` in CI** - formatting drift not caught | `.github/workflows/ci.yml` |
| 6 | **Inconsistent focus style** - mission textarea uses `:focus` instead of `:focus-visible` | `src/styles.css:1319-1324` |

---

## MEDIUM PRIORITY

### Architecture

| # | Issue | Location |
|---|-------|----------|
| 7 | **VoicePanel is a 1316-line god component** managing entire voice pipeline state machine, PTT, wake word, approvals, streaming, etc. | `src/voice/VoicePanel.tsx` |
| 8 | **SettingsPanel is 1944 lines** with 15+ internal components not physically separated | `src/app/SettingsPanel.tsx` |
| 9 | **No `React.memo` usage** anywhere - list items re-render on unrelated state changes | All `.tsx` files |

### Performance

| # | Issue | Location |
|---|-------|----------|
| 10 | **No code splitting** beyond the two faces - Settings/Missions/Runs all bundled together | `src/app/AppWindow.tsx:349` |
| 11 | **`read_settings` on hot path** without caching (Tauri commands + voice path) | `src-tauri/src/settings.rs:169` |
| 12 | **`useRuns()` fetches on mount** even when user is on Models tab | `src/app/SettingsPanel.tsx:1504-1513` |

### Data Layer

| # | Issue | Location |
|---|-------|----------|
| 13 | **TOCTOU in settings write lock** - automation MCP server cannot share the mutex | `src-tauri/src/settings.rs:8-14` |
| 14 | **No rate limiting** on Tauri commands (voice-path STT/TTS commands) | `src-tauri/src/lib.rs:116-157` |
| 15 | **Trigger read cap mismatch** - Rust reads 64KB but TS caps at 4000 chars | `src-tauri/src/scheduler.rs:404` |

### UX

| # | Issue | Location |
|---|-------|----------|
| 16 | **Settings section nav has no active/scroll-spy indicator** | `src/app/SettingsPanel.tsx:249-262` |
| 17 | **Number inputs lack `max` constraints** (999999 minutes is valid) | `src/app/SettingsPanel.tsx:1097-1105` |
| 18 | **MCP server URL field has no validation** | `src/app/SettingsPanel.tsx:1421-1428` |
| 19 | **Radio groups lack `role="radiogroup"` and `aria-label`** | `src/app/SettingsPanel.tsx:699-730` |

### DevOps

| # | Issue | Location |
|---|-------|----------|
| 20 | **No E2E tests** - only unit tests in CI | `.github/workflows/ci.yml` |
| 21 | **No Linux CI matrix** | `.github/workflows/ci.yml:44-48` |
| 22 | **CSP allows `'unsafe-inline'`** for styles in production | `src-tauri/tauri.conf.json:29` |

---

## LOW PRIORITY (Polish)

| # | Issue | Location |
|---|-------|----------|
| 23 | Orb breathing animation never pauses (battery drain on laptops) | `src/styles.css:234` |
| 24 | Waveform creates 28-element arrays at 11Hz (fine for 28 bars, but not scalable) | `src/voice/VoicePanel.tsx:1090-1103` |
| 25 | Component test coverage thin (3 files, 8 tests for React components) | `src/app/`, `src/voice/` |
| 26 | Duplicate `truncate`/`cap_chars` functions in Rust | `scheduler.rs:452`, `agent_runner.rs:79` |
| 27 | Onboarding card has misleading radius fallback `16px` vs actual `20px` | `src/styles.css:1638` |
| 28 | `tsconfig.tsbuildinfo` exists in repo but gitignored (may need `git rm --cached`) | `.gitignore:7` |
| 29 | OpenAI brain uses non-streaming completions (perceived latency) | `agent/openai-brain.ts:17-18` |
| 30 | `.agents/` and `.claude/` dirs undocumented | Root directory |

---

## What's Done Exceptionally Well

1. **Security architecture** - Secrets never cross IPC, privacy enforced at execution boundaries, fail-closed safety policy
2. **CSS design system** - Consistent 4px spacing scale, 5-step type ramp, semantic colors
3. **Voice pipeline optimization** - `LiveWaveform` + imperative orb glow avoids 11Hz re-renders on 1316-line component
4. **Error recovery** - Auto-expire transient errors, auto-recover to idle, transcription timeout with `Promise.race`
5. **Settings merge strategy** - Separate general/automation write paths prevent stale snapshots from clobbering voice-created schedules
6. **`prefers-reduced-motion`** - Comprehensive handling disabling all animations
7. **Focus management on approval gates** - Auto-focus Reject, Esc to deny (safety-critical)
8. **Atomic writes** everywhere with temp+rename pattern
9. **Resident agent process** with crash recovery/backoff
10. **Documentation quality** - Exceptional inline comments with plan/phase references
