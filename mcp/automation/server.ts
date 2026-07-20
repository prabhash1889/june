#!/usr/bin/env node
// automation MCP server (improvement-5 P1.5): create automations by voice - the
// flagship autonomy feature of a voice agent, which until now started from a
// settings textarea. June can add a scheduled run or a repeat-until watch loop and
// list what exists, all spoken. The add_* tools are classed `expensive` in
// agent/policy.ts, so they are GATED (and spoken-approvable, 14.2): June never
// silently schedules itself, and an UNATTENDED run can't create automations at all
// (18.2 blocks expensive actions), so a scheduled run can't spawn more of itself.
//
// Same containment shape as mcp/memory and mcp/lessons: the settings file path is
// fixed by the host (JUNE_SETTINGS_FILE, an app-data path), so the model can only
// ever touch that one file. Writes go straight to settings.json (atomic temp +
// rename); the Rust scheduler re-reads settings every tick, so a written schedule
// or watch is live within 30s with no restart. It is local (no network), so it
// stays available under every privacy mode.
//
// ponytail: a direct settings.json write doesn't emit `settings://changed`, so an
// open Settings panel won't refresh until reloaded - acceptable (the scheduler is
// the consumer that matters). Route through a Tauri command if that ever bites.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  type SettingsBag,
  summarizeAutomations,
  validateSchedule,
  validateWatch,
  withSchedule,
  withWatch,
} from "./store.ts";

/** The one settings file, resolved once at startup. Fail loudly if unset - the
 *  host always sets it when it spawns the resident. */
function settingsFile(): string {
  const raw = process.env.JUNE_SETTINGS_FILE;
  if (!raw || !raw.trim()) {
    throw new Error("JUNE_SETTINGS_FILE is not set - the automation capability has no file.");
  }
  return path.resolve(raw.trim());
}

const FILE = settingsFile();

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Read the settings bag, empty object if missing/garbled (a fresh install). */
async function readBag(): Promise<SettingsBag> {
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as SettingsBag) : {};
  } catch {
    return {};
  }
}

/** Persist the whole bag atomically (temp + rename, mirroring the Rust side and
 *  the memory/lessons servers), preserving every key we didn't touch. */
async function writeBag(bag: SettingsBag): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(bag, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, FILE);
}

// Serialize read-modify-write so two tool calls landing together can't clobber
// each other's automation (each reads the file, appends, writes it whole - a race
// would drop one entry). Gated tool calls are already serialized by the approval
// flow in practice, but this guarantees it regardless of call ordering.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

const server = new McpServer({ name: "automation", version: "0.1.0" });

server.registerTool(
  "add_schedule",
  {
    title: "Add a scheduled run",
    description:
      "Create a scheduled unattended run: June runs the given task on its own, either daily at a time or every N minutes. Use for 'every morning brief me', 'check my inbox every hour'. The run is unattended, so any action needing approval is blocked - use it for read-and-report tasks.",
    inputSchema: {
      label: z.string().min(1).describe("A short name for the schedule, e.g. 'Morning briefing'."),
      prompt: z.string().min(1).describe("The task to run, phrased as an instruction."),
      kind: z.enum(["daily", "every"]).default("daily").describe("'daily' at a time, or 'every' N minutes."),
      time: z.string().optional().describe("24h HH:MM for a daily schedule, e.g. '09:00'."),
      everyMinutes: z.number().int().positive().optional().describe("Interval in minutes for an 'every' schedule."),
      days: z.array(z.number().int().min(0).max(6)).optional().describe("Days for a daily schedule, 0=Sun..6=Sat; omit for every day."),
    },
  },
  (input): Promise<CallToolResult> =>
    serialize(async () => {
      try {
        const schedule = validateSchedule({ ...input, enabled: true });
        if (!schedule) {
          return fail("I need a valid time (HH:MM) for a daily schedule, or a minute interval for an 'every' schedule.");
        }
        await writeBag(withSchedule(await readBag(), schedule));
        const recur = schedule.kind === "every" ? `every ${schedule.everyMinutes} minutes` : `daily at ${schedule.time}`;
        return ok(`Scheduled "${schedule.label}" to run ${recur}. It runs unattended and reports back.`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }),
);

server.registerTool(
  "add_watch",
  {
    title: "Add a watch loop",
    description:
      "Create a repeat-until watch loop: June re-checks something every N minutes and stops when a condition holds, e.g. 'check the build every ten minutes until it's green'. Each check is unattended (observe-only). June stops after a capped number of checks even if the condition never comes true.",
    inputSchema: {
      label: z.string().min(1).describe("A short name for the watch, e.g. 'Build watch'."),
      prompt: z.string().min(1).describe("What to check each time, phrased as an instruction."),
      everyMinutes: z.number().int().positive().describe("How often to re-check, in minutes."),
      untilCondition: z.string().optional().describe("The stop condition in plain words, e.g. 'the build is green'."),
    },
  },
  (input): Promise<CallToolResult> =>
    serialize(async () => {
      try {
        const watch = validateWatch({ ...input, enabled: true });
        if (!watch) return fail("I need a positive minute interval for a watch loop.");
        await writeBag(withWatch(await readBag(), watch));
        const until = watch.untilCondition ? ` until ${watch.untilCondition}` : "";
        return ok(`Watching "${watch.label}" every ${watch.everyMinutes} minutes${until}. I'll stop and tell you when it's done.`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }),
);

server.registerTool(
  "list_automations",
  {
    title: "List automations",
    description: "List the current scheduled runs, watch loops, and file triggers.",
    inputSchema: {},
  },
  (): Promise<CallToolResult> =>
    serialize(async () => {
      try {
        return ok(summarizeAutomations(await readBag()));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel - proof-of-life goes to stderr only.
  process.stderr.write(`[automation] MCP server ready on stdio (file: ${FILE})\n`);
}

main().catch((e) => {
  process.stderr.write(`[automation] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
