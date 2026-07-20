#!/usr/bin/env node
// memory MCP server (PLAN.md Phase 11.4: long-term memory). June's one persistent,
// user-editable memory file (`june-memory.md`) is managed with the Anthropic
// memory-tool pattern: the file is injected into the system prompt at the start of
// every conversation (agent/core.ts), and THIS server is how June writes to it -
// saving a durable fact the user stated ("prefers Codex agents", "work repo is at
// C:/dev/app") so it survives across conversations. No vector store.
//
// Unlike mcp/files, the file path is fixed by the host (JUNE_MEMORY_FILE, an
// app-data path) and the tool takes NO path argument, so the model can only ever
// touch this one file - path-contained by construction (§5). It is local (no
// network), so it stays available under every privacy mode.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { appendFact } from "./store.ts";

/** Cap the memory file so an over-eager model can't grow the system prompt
 *  without bound; oldest lines fall off first (store.ts). ponytail: hard byte cap,
 *  raise it (or add a summarize-on-overflow pass) only if real memories hit it. */
const MAX_MEMORY_BYTES = 16_000;

/** The one memory file, resolved once at startup. Fail loudly if unset - the host
 *  always sets it when it spawns the resident. */
function memoryFile(): string {
  const raw = process.env.JUNE_MEMORY_FILE;
  if (!raw || !raw.trim()) {
    throw new Error("JUNE_MEMORY_FILE is not set - the memory capability has no file.");
  }
  return path.resolve(raw.trim());
}

const FILE = memoryFile();

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new McpServer({ name: "memory", version: "0.1.0" });

server.registerTool(
  "remember",
  {
    title: "Remember",
    description:
      'Save a durable fact about the user or their preferences to long-term memory (for example "prefers Codex over Claude agents" or "work repo is at C:/dev/app"). Use this only for lasting facts worth recalling in future conversations, never for one-off details. Everything remembered is shown to you at the start of every conversation.',
    inputSchema: {
      fact: z.string().min(1).describe("A single durable fact to remember, one short sentence."),
    },
  },
  async ({ fact }): Promise<CallToolResult> => {
    try {
      const existing = await fs.readFile(FILE, "utf-8").catch(() => "");
      const next = appendFact(existing, fact, MAX_MEMORY_BYTES);
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      // Atomic write (temp + rename, mirroring the Rust side): a crash mid-write
      // can never leave the memory file truncated or half-rewritten (B4.2).
      const tmp = `${FILE}.tmp`;
      await fs.writeFile(tmp, next.endsWith("\n") ? next : `${next}\n`, "utf-8");
      await fs.rename(tmp, FILE);
      return ok(`Remembered: ${fact.trim()}`);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel - proof-of-life goes to stderr only.
  process.stderr.write(`[memory] MCP server ready on stdio (file: ${FILE})\n`);
}

main().catch((e) => {
  process.stderr.write(`[memory] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
