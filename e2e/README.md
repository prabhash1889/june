# June E2E smoke harness (improvement-8 1.1)

`tauri-driver` + WebdriverIO drive the real Tauri shell so the smoke path covers
what every unit test cannot: the native windows, the WebView2 webview, and the
resident's process tree (orphaned-webview / sync-command-deadlock / kill-tree
classes). **Windows only** (WebView2).

## Status

Scaffold. The harness is wired but not yet proven green on a runner, so it runs as
a **manual** CI job (`.github/workflows/e2e.yml`, `workflow_dispatch`) - it does
NOT gate PRs until it has been stabilized on a real Windows + WebView2 machine.
Promote it to the `pull_request` triggers once it passes reliably.

## Prerequisites

- Rust toolchain (builds the debug app).
- `cargo install tauri-driver`.
- A WebView2 runtime, and `msedgedriver` matching its version on `PATH`.
- Node 20+.

## Stubbed brain

The smoke turn must round-trip without a real API key. Launch the app with
`JUNE_APPROVE=allow` and a keyless/echo provider selected (an Ollama/LM Studio
compat endpoint, or a local stub) so `say hello` produces a reply bubble with no
network or approval prompt. Wire this in `wdio.conf.js` `beforeSession` env when
promoting the job.

## Run locally

```bash
cd e2e
npm install
npm test        # builds the debug app, starts tauri-driver, runs specs/smoke.e2e.js
```

## What it asserts

1. The always-on widget shows a live push-to-talk orb.
2. Opening the full window and sending one stubbed command lands a reply bubble.
3. After quit, no orphaned `serve.ts` node process survives (kill-tree, B-1.10).
