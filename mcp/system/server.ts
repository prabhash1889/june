#!/usr/bin/env node
// system MCP server (improvement-6 4.3): a local, observe-only "eyes" pack so an
// unattended watch loop can actually see the machine - "watch until the build is
// green" needs to know whether the build process is still running, not just read
// files. Everything here is a LOCAL read (no network), so it is offline-safe and
// stays enabled under Strict offline, like the files/memory servers.
//
// It runs as a node subprocess (spawned by the Rust host via agent_runner.rs) with
// no channel back to the host, so it reads the OS directly: node's `os` module for
// stats, and a `tasklist` shell-out for the process list. Windows-first (June's
// platform); the process tools degrade to an error on other OSes rather than lying.

import { exec } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { countProcesses, parseActiveContext, parseTasklistCsv, summarizeStats, type ProcessInfo } from "./parse.ts";

const execAsync = promisify(exec);

/** Cap tasklist output so a machine with thousands of processes can't flood a
 *  voice reply or the JSON-RPC pipe. */
const MAX_TASKLIST_BUFFER = 4 * 1024 * 1024;

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read the running process list. Windows-only (`tasklist`); other platforms get a
 *  clear error rather than a silent empty list that reads as "nothing running". */
async function readProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") {
    throw new Error("Process listing is only supported on Windows.");
  }
  const { stdout } = await execAsync("tasklist /FO CSV /NH", { maxBuffer: MAX_TASKLIST_BUFFER });
  return parseTasklistCsv(stdout);
}

/** PowerShell that reads the FOREGROUND window's own metadata via Win32 (no
 *  display capture): title + owning process name/pid, emitted as one-line JSON.
 *  Note `$fgPid` not `$pid` - `$pid` is a PowerShell automatic (this process). */
const ACTIVE_CONTEXT_PS = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class JuneFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [JuneFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][JuneFg]::GetWindowText($h, $sb, $sb.Capacity)
$fgPid = [uint32]0
[void][JuneFg]::GetWindowThreadProcessId($h, [ref]$fgPid)
$proc = $null
try { $proc = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch {}
[pscustomobject]@{ title = $sb.ToString(); processName = $proc; pid = [int]$fgPid } | ConvertTo-Json -Compress
`;

/** Run a PowerShell script via -EncodedCommand (UTF-16LE base64) so the script's
 *  quotes/newlines never fight the shell. */
async function runPwsh(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 1024 * 1024 },
  );
  return stdout;
}

const server = new McpServer({ name: "system", version: "0.1.0" });

server.registerTool(
  "list_processes",
  {
    title: "List processes",
    description:
      "List the running processes on this machine (name, PID, memory). Read-only. Use to check what is running, e.g. whether a build or dev server is still alive.",
    inputSchema: {},
  },
  async () => {
    try {
      const procs = await readProcesses();
      return ok(JSON.stringify(procs, null, 2));
    } catch (e) {
      return fail(msg(e));
    }
  },
);

server.registerTool(
  "process_running",
  {
    title: "Is a process running",
    description:
      "Check whether a named process is currently running (case-insensitive, with or without a .exe suffix). Read-only. Returns true/false plus how many instances match.",
    inputSchema: {
      name: z.string().describe('Process name to look for, e.g. "node", "chrome", or "cargo.exe"'),
    },
  },
  async ({ name }) => {
    try {
      const procs = await readProcesses();
      const count = countProcesses(name, procs);
      return ok(JSON.stringify({ name, running: count > 0, instances: count }));
    } catch (e) {
      return fail(msg(e));
    }
  },
);

server.registerTool(
  "system_stats",
  {
    title: "System stats",
    description:
      "Report machine health: CPU count, memory used/total, uptime, and load average (non-Windows). Read-only. Use to answer 'how much memory is free' or 'is the machine under load'.",
    inputSchema: {},
  },
  async () => {
    try {
      const summary = summarizeStats({
        platform: os.platform(),
        cpuCount: os.cpus().length,
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        uptimeSeconds: os.uptime(),
        loadAvg1: os.loadavg()[0] ?? 0,
      });
      return ok(JSON.stringify(summary, null, 2));
    } catch (e) {
      return fail(msg(e));
    }
  },
);

server.registerTool(
  "get_active_context",
  {
    title: "Active window context",
    description:
      "Get metadata about the window the user is currently looking at: its title and owning app (process). Read-only, local, and metadata-only - it does NOT capture or read the screen contents. Use to answer 'what am I looking at' without a screenshot.",
    inputSchema: {},
  },
  async () => {
    try {
      if (process.platform !== "win32") {
        return fail("Active-window context is only supported on Windows.");
      }
      const ctx = parseActiveContext(await runPwsh(ACTIVE_CONTEXT_PS));
      return ok(JSON.stringify(ctx));
    } catch (e) {
      return fail(msg(e));
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel - proof-of-life goes to stderr only.
  process.stderr.write(`[system] MCP server ready on stdio (platform: ${process.platform})\n`);
}

main().catch((e) => {
  process.stderr.write(`[system] fatal: ${msg(e)}\n`);
  process.exit(1);
});
