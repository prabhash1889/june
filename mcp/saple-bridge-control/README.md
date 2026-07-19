# saple-bridge-control MCP server

Phase 2 of [June](../../PLAN.md). Wraps the Phase 1 saple-bridge control
endpoint as an MCP tool surface, so any MCP client (Claude Code, and later
June's own agent core) can drive saple-bridge by tool call.

It is a thin proxy: each tool becomes one contract `command`, and bridge's
response - error codes and batch counts included - is returned **verbatim**.

## Tools

| Tool | Contract action | Arguments |
| --- | --- | --- |
| `spawn_agents` | `spawn_agents` | `provider`, `model?`, `count`, `prompt?` |
| `assign_task` | `assign_task` | `agent_id`, `task` |
| `send_to_terminal` | `write_terminal` | `pane_id`, `data` |
| `close_terminal` | `close_terminal` | `pane_id` |
| `open_browser` | `open_browser` | `url` |
| `get_swarm_status` | `get_swarm_status` | (none) |

Every tool also accepts an optional `workspace_id` (scopes `observe` routing,
default `june`). Mutating tools accept an optional `request_id`: reuse it across
retries and bridge replays the original result idempotently; omit it and each
call is a fresh intent.

## Prerequisites

1. saple-bridge is running with a project/workspace open.
2. In bridge: **Settings → Workspace → "June Voice Control"** is ON, and bridge
   was restarted after enabling it (the endpoint binds once at startup).
3. This repo has had `npm install` (provides `tsx`, the MCP SDK, and `zod`).

The server finds and authenticates to bridge through its discovery record
(`%APPDATA%/ai.saple.bridge/june-control.json`), verifying the pid is alive and
the protocol version matches before issuing any command. If bridge isn't
reachable, every tool returns a contract `bridge_unavailable` error rather than
failing opaquely.

## Attach it to an MCP client

See [`mcp.config.example.json`](./mcp.config.example.json). For Claude Code:

```bash
claude mcp add saple-bridge-control -- npx tsx <abs-path>/mcp/saple-bridge-control/server.ts
```

Adjust the absolute path to this file on your machine.

## Run standalone (sanity check)

```bash
npx tsx mcp/saple-bridge-control/server.ts
```

It prints `MCP server ready on stdio` to stderr and then speaks JSON-RPC over
stdin/stdout.
