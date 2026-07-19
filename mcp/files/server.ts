#!/usr/bin/env node
// files MCP server (PLAN.md Phase 9: "add 1-2 non-saple MCP capabilities ... to
// prove extensibility"). This is the proof that June is general-purpose, not a
// saple front-end: it drives the local filesystem through the SAME MCP seam the
// saple-bridge-control server uses, so "adding a capability is a server, not a
// plugin system" (§2) is now demonstrated with a second, unrelated server.
//
// It is a LOCAL capability - no network - so it is offline-safe and stays
// enabled under Strict offline (§5), unlike the cloud brain/voice stages.
//
// Safety (§5 "Path containment & canonical-file whitelist"): every path is
// resolved against a single allowed root and rejected if it escapes. The root
// comes from JUNE_FILES_ROOT (set by the host when the user enables + points the
// capability at a folder); there is no way to reach a file outside it. Writes are
// an "external effect" and are gated by June's approval layer (agent/policy.ts),
// so a voice command can read freely but never overwrite a file without a yes.

import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { isWithin, resolveWithin, utf8SafeEnd } from "./paths.ts";

/** Cap a single read so a voice reply can't be flooded by a huge file. */
const MAX_READ_BYTES = 100_000;

/** The canonical allowed root, resolved once at startup. Fail loudly if unset -
 *  the host only attaches this server when a root is configured. */
function allowedRoot(): string {
  const raw = process.env.JUNE_FILES_ROOT;
  if (!raw || !raw.trim()) {
    throw new Error("JUNE_FILES_ROOT is not set - the files capability has no allowed folder.");
  }
  // realpath so the containment prefix is compared against the canonical path
  // (resolves symlinks in the root itself, drive-letter casing, etc.).
  return realpathSync(path.resolve(raw.trim()));
}

const ROOT = allowedRoot();

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** After resolving an EXISTING path, confirm its realpath is still inside the
 *  root - catches a symlink inside the root that points outside it. */
async function assertRealWithin(abs: string): Promise<void> {
  const real = await fs.realpath(abs);
  if (!isWithin(ROOT, real)) {
    throw new Error("That path resolves outside the allowed folder.");
  }
}

const server = new McpServer({ name: "files", version: "0.1.0" });

server.registerTool(
  "list_files",
  {
    title: "List files",
    description:
      "List the files and folders in the allowed folder (or a subfolder of it). Read-only. Returns each entry's name, type, and size.",
    inputSchema: {
      subdir: z.string().optional().describe("Relative subfolder to list; omit for the root of the allowed folder"),
    },
  },
  async ({ subdir }) => {
    try {
      const dir = resolveWithin(ROOT, subdir ?? ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const rows = await Promise.all(
        entries.map(async (e) => {
          const kind = e.isDirectory() ? "dir" : "file";
          let size = 0;
          if (e.isFile()) {
            size = (await fs.stat(path.join(dir, e.name)).catch(() => ({ size: 0 }))).size;
          }
          return { name: e.name, kind, size };
        }),
      );
      return ok(JSON.stringify(rows, null, 2));
    } catch (e) {
      return fail(msg(e));
    }
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description: "Read a UTF-8 text file inside the allowed folder. Read-only. Large files are truncated.",
    inputSchema: {
      path: z.string().describe("Path to the file, relative to the allowed folder"),
    },
  },
  async ({ path: rel }) => {
    try {
      const abs = resolveWithin(ROOT, rel);
      await assertRealWithin(abs);
      const buf = await fs.readFile(abs);
      const truncated = buf.length > MAX_READ_BYTES;
      const text = buf.subarray(0, utf8SafeEnd(buf, MAX_READ_BYTES)).toString("utf-8");
      return ok(truncated ? `${text}\n\n[truncated - file is ${buf.length} bytes]` : text);
    } catch (e) {
      return fail(msg(e));
    }
  },
);

server.registerTool(
  "write_file",
  {
    title: "Write file",
    description:
      "Write a UTF-8 text file inside the allowed folder, creating parent folders as needed. This overwrites an existing file, so it is a gated action that needs approval.",
    inputSchema: {
      path: z.string().describe("Path to the file, relative to the allowed folder"),
      content: z.string().describe("Full text to write to the file"),
    },
  },
  async ({ path: rel, content }) => {
    try {
      const abs = resolveWithin(ROOT, rel);
      // Guard the parent dir's real path too, so a symlinked folder can't be used
      // to write outside the root. The file itself need not exist yet.
      const parent = path.dirname(abs);
      await fs.mkdir(parent, { recursive: true });
      await assertRealWithin(parent);
      await fs.writeFile(abs, content, "utf-8");
      return ok(`Wrote ${content.length} characters to ${rel}.`);
    } catch (e) {
      return fail(msg(e));
    }
  },
);

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel - proof-of-life goes to stderr only.
  process.stderr.write(`[files] MCP server ready on stdio (root: ${ROOT})\n`);
}

main().catch((e) => {
  process.stderr.write(`[files] fatal: ${msg(e)}\n`);
  process.exit(1);
});
