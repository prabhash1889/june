#!/usr/bin/env node
// lessons MCP server (improvement-4 Phase 17.1: post-run lesson writer - the
// BridgeAgent playbook trick, verified real). After finishing a task the agent
// can save a short "lesson" ("when spawning codex agents, pass the model id") to
// a growing, user-visible file (`june-lessons.md`). Before the next task, the
// resident recalls the top-k relevant lessons into the turn (Phase 17.2, in
// agent/serve.ts) so June gets better at repeated work.
//
// Same shape as mcp/memory: the file path is fixed by the host (JUNE_LESSONS_FILE,
// an app-data path) and the tool takes NO path argument, so the model can only
// ever touch this one file - path-contained by construction. It is local (no
// network), so it stays available under every privacy mode.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { appendLesson } from "./store.ts";

/** Cap the lessons corpus so recall stays cheap and the file can't grow without
 *  bound; the oldest lessons fall off first (store.ts). ponytail: fixed count +
 *  byte caps, add a keyword-vector index only if the corpus provably outgrows a
 *  linear keyword scan (17.2's explicit deferral condition). */
const MAX_LESSONS = 60;
const MAX_LESSON_BYTES = 24_000;

/** The one lessons file, resolved once at startup. Fail loudly if unset - the
 *  host always sets it when it spawns the resident. */
function lessonsFile(): string {
  const raw = process.env.JUNE_LESSONS_FILE;
  if (!raw || !raw.trim()) {
    throw new Error("JUNE_LESSONS_FILE is not set - the lessons capability has no file.");
  }
  return path.resolve(raw.trim());
}

const FILE = lessonsFile();

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new McpServer({ name: "lessons", version: "0.1.0" });

server.registerTool(
  "record_lesson",
  {
    title: "Record lesson",
    description:
      'After finishing a task, save one short, reusable lesson about how to do it better next time (for example "when spawning codex agents, always pass the model id, or they default to a slow model"). Use this only for durable, task-relevant know-how worth recalling on a similar task, never for one-off details. The most relevant lessons are shown back to you before a similar task.',
    inputSchema: {
      lesson: z
        .string()
        .min(1)
        .describe("A single reusable lesson, one short sentence, phrased so it helps on a similar future task."),
    },
  },
  async ({ lesson }): Promise<CallToolResult> => {
    try {
      const existing = await fs.readFile(FILE, "utf-8").catch(() => "");
      const next = appendLesson(existing, lesson, MAX_LESSONS, MAX_LESSON_BYTES);
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      // Atomic write (temp + rename, mirroring the Rust side): a crash mid-write
      // can never leave the lessons file truncated or half-rewritten (B4.2).
      const tmp = `${FILE}.tmp`;
      await fs.writeFile(tmp, next.endsWith("\n") ? next : `${next}\n`, "utf-8");
      await fs.rename(tmp, FILE);
      return ok(`Noted for next time: ${lesson.trim()}`);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel - proof-of-life goes to stderr only.
  process.stderr.write(`[lessons] MCP server ready on stdio (file: ${FILE})\n`);
}

main().catch((e) => {
  process.stderr.write(`[lessons] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
