# June agent core (text-only)

Phase 3 of [June](../PLAN.md): the whole control loop, typed, no voice. Type a
command, June runs it through a Claude-powered tool-calling loop against the
`saple-bridge-control` MCP tools (Phase 2), gates dangerous actions for human
approval, and reports outcomes **only from tool results**.

This is the ★ de-risking milestone: once the loop works typed, adding STT/TTS
(Phases 4-5) is mechanical.

## Layout

| File | Role |
| --- | --- |
| `brain.ts` | Provider-neutral `Brain` interface + turn/streaming/gate types |
| `claude-brain.ts` | Claude impl over `@anthropic-ai/claude-agent-sdk` (the only committed brain; a second provider is a later `Brain` impl, not a new loop) |
| `policy.ts` | The approval gate's brain-independent core: §5 action classes, which are gated, exact-count confirmation text |
| `prompt.ts` | Voice-tuned system prompt (spoken style, numbers spelled out, no markdown) |
| `core.ts` | Orchestrator: wires the brain to its MCP capabilities and the gate |
| `cli.ts` | Text-only harness (one-shot or REPL) |

## The approval gate (PLAN.md §5)

The gate lives in June's **execution layer**, not the brain's prompt: it is
routed through the Agent SDK's `canUseTool` hook, so the brain physically cannot
run a gated tool without a decision from `policy.ts`. Swapping the brain
(Claude → GPT → local) cannot skip a gate, because the gate is not in the brain.
`spawn_agents` (expensive) and `close_terminal` (destructive) require approval;
observe/reversible actions run automatically. The gate **fails closed** - if no
approval can be obtained, the action is denied.

> Deferred to a hardening pass: the §5 *one-time token verified by bridge*. The
> execution-layer gate already meets the Phase 3 exit criterion (the brain
> cannot bypass it); bridge-side token minting/verification is defense-in-depth
> for a compromised core and is best done with the Rust authority migration.

## Run it

Prerequisites: saple-bridge running with a workspace open and "June Voice
Control" enabled (see [`../mcp/saple-bridge-control/README.md`](../mcp/saple-bridge-control/README.md)),
plus an authenticated `claude` CLI **or** `ANTHROPIC_API_KEY`.

```bash
# one-shot
npm run agent -- "open five claude agents and four codex agents in this workspace"

# interactive REPL
npm run agent
```

Approvals are prompted at the terminal. For headless runs set
`JUNE_APPROVE=allow|deny` to apply a fixed policy instead of prompting.
`JUNE_WORKSPACE_ID` sets the logical workspace (default `june`).

## Not yet (later in Phase 3 / next phases)

- App-UI surface for the stream and approval cards (this harness is the text
  interface that proves the loop; the React/Tauri surface reuses this same core).
- saple-memory / artemis attached as additional MCP capabilities (config
  entries via `createJuneAgent({ extraMcpServers })`, no new code).
