# June

A local-first voice agent that controls the SAPLE ecosystem (and more) by voice. See
[`PLAN.md`](./PLAN.md) for the full design and phased roadmap.

**Status:** Phase 0 (foundations) complete - an empty Tauri window with tray presence and a
persisted settings store. No voice, no agent loop, no capabilities yet; those land in later
phases.

Built with **Tauri v2** (Rust shell) + **React 19 + TypeScript + Vite**, mirroring the
conventions used by `saple-bridge` and `artemis-desktop` in this workspace.

## Develop

```bash
npm install
npm run dev          # Vite frontend only, http://localhost:1421 (browser)
npm run tauri dev    # native window (requires Rust + Tauri CLI)
npm run build        # typecheck + Vite production build
```

## Checks

```bash
npm run typecheck
npm run lint
npm test

cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Layout

- `src/` - React frontend (currently just the empty foundation window).
- `src-tauri/src/lib.rs` - app entry: single-instance lock, window-state restore, tray icon.
- `src-tauri/src/settings.rs` - JSON settings store at `<app_data_dir>/settings.json`.
- `src-tauri/src/keychain.rs` - OS keychain wiring for provider API keys
  (`june_provider_<provider>_api_key`, account `june_user`). No secret ever crosses the IPC
  boundary back to the renderer.
