#!/usr/bin/env node
// The RESIDENT agent process (PLAN.md Phase 11.1) - the multiplier that ends
// per-utterance amnesia and per-turn spawn latency. Where Phase 4-10 spawned a
// fresh `run-once.ts` per turn (cmd -> npx -> tsx -> connect every MCP server,
// every time), this stays up for the whole app session: ONE agent core, MCP
// connections kept warm, conversation history carried across turns (Phase 11.2).
//
// Protocol: newline-delimited JSON on the stdio pair the Tauri host holds.
//
//   Requests (stdin):
//     {"type":"run","turn":N,"transcript":"..."}   run one user turn
//     {"type":"approve","approvalId":M,"decision":"allow"|"deny"}
//     {"type":"cancel","turn":N}                   abort turn N's in-flight work
//     {"type":"reset"}                             start a fresh conversation
//
//   Events (stdout), every one tagged with its `turn`:
//     {"t":"ready"}                       emitted once, when the core is up
//     {"t":"text","turn":N,"delta":...}
//     {"t":"tool","turn":N,"action":...,"input":...}
//     {"t":"result","turn":N,"action":...,"res":...,"isError":...}
//     {"t":"approval","turn":N,"id":M,"action":...,"cls":...,"summary":...}
//     {"t":"approval-expired","turn":N,"id":M}
//     {"t":"audit","turn":N,...}          one per tool call (10.7)
//     {"t":"final","turn":N,"text":...,"isError":...,"usage":{...}?}
//
// The approval gate still lives here in June's execution layer (PLAN.md §5), not
// in any brain: the single canUseTool/gate choke point audits every call and
// blocks gated ones until a `{approve}` arrives. Turns are serialized (the
// widget owns the mic); a `run` that arrives mid-turn PREEMPTS the active turn
// (barge-in) rather than queueing behind it, so a new command never waits on an
// abandoned one.

import { promises as fs } from "node:fs";
import { type Interface, createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

import { resolveMcpEntries, serverDefaults } from "../src/lib/mcp-servers.ts";
import { frameUnattended } from "../src/lib/schedules.ts";
import { type PrivacyMode, providerAllowed } from "../src/lib/privacy.ts";
import { resolveProvider } from "../src/lib/providers.ts";
import { createJuneAgent } from "./core.ts";
import { setServerDefaults } from "./policy.ts";
import { ApprovalHub, type RunRequest, parseMcpServers, parseRequest, withRecalledLessons } from "./protocol.ts";

const PRIVACY_MODES: PrivacyMode[] = ["standard", "local-voice", "strict-offline"];

function emit(obj: Record<string, unknown>): void {
  stdout.write(JSON.stringify(obj) + "\n");
}

/** Read the lessons file (Phase 17.2), empty string if missing. Re-read each turn
 *  so a lesson written earlier this session is recalled on the next task without a
 *  respawn - the file is small (capped, 24KB) so a local read per turn is cheap. */
async function readLessons(file: string | undefined): Promise<string> {
  if (!file) return "";
  return fs.readFile(file, "utf-8").catch(() => "");
}

/** Resolve the brain the host selected via env into createJuneAgent options,
 *  defaulting to Claude. Read once at startup: the host respawns this process
 *  when settings change, so the resident never runs on a stale config. */
function brainConfig(): { provider: string; model?: string; baseUrl?: string; apiKey?: string } {
  const provider = process.env.JUNE_BRAIN_PROVIDER || "claude";
  const p = resolveProvider("brain", provider);
  return {
    provider,
    model: process.env.JUNE_BRAIN_MODEL || undefined,
    baseUrl: process.env.JUNE_BRAIN_BASE_URL || p?.baseUrl || undefined,
    apiKey: process.env.JUNE_BRAIN_API_KEY || undefined,
  };
}

async function main(): Promise<void> {
  const brain = brainConfig();

  // The approval hub owns the pending-approval state and the gate/round-trip/
  // cancel logic (2.9); it emits through the real stdout `emit`.
  const hub = new ApprovalHub(emit);

  // Privacy enforcement at the execution boundary (PLAN.md §5): refuse a
  // networked brain when the mode forbids it. Computed once (env is fixed for
  // the resident's life); a blocked provider fails every run with a clear message.
  const mode = process.env.JUNE_PRIVACY_MODE as PrivacyMode | undefined;
  const p = resolveProvider("brain", brain.provider);
  const brainBlocked =
    p && mode && PRIVACY_MODES.includes(mode) && !providerAllowed(mode, "brain", p)
      ? `Privacy mode blocks the ${p.label} brain. Choose a local brain or change the mode in settings.`
      : null;

  const filesRoot = process.env.JUNE_FILES_ROOT?.trim() || undefined;
  // On-device privacy keeps nothing on disk: the Claude brain's session history is
  // persisted ONLY under standard mode (1.4). local-voice also redacts the run
  // ledger, so persisting full SDK transcripts there was a leak; only standard
  // mode writes transcripts. An unset mode defaults to standard (persist).
  const persistSession = !mode || mode === "standard";

  // Long-term memory (Phase 11.4): the host points us at one june-memory.md; read
  // it once at spawn and inject it into the system prompt. A settings save or a
  // memory edit respawns the resident, so this stays current. Missing file -> no
  // memory yet, which is fine (the remember tool creates it on first use).
  const memoryFile = process.env.JUNE_MEMORY_FILE?.trim() || undefined;
  const memory = memoryFile ? await fs.readFile(memoryFile, "utf-8").catch(() => undefined) : undefined;

  // Post-run lessons (Phase 17.1/17.2): the host points us at one june-lessons.md.
  // Unlike memory, lessons are recalled per-turn (top-k relevant to the task, 17.2)
  // rather than injected whole, so we only need the file path here; hasLessons
  // seeds the system-prompt wording. The file grows during a session (record_lesson),
  // so recall re-reads it each turn (readLessons below) rather than caching at spawn.
  const lessonsFile = process.env.JUNE_LESSONS_FILE?.trim() || undefined;
  const hasLessons = lessonsFile ? Boolean((await readLessons(lessonsFile)).trim()) : false;

  // Voice-created automations (improvement-5 P1.5): the host points us at
  // settings.json so the automation MCP server can add schedules/watch loops the
  // Rust scheduler reads each tick. Local + user-visible, so it stays on in every
  // privacy mode; the add_* tools are gated in policy.ts.
  const settingsFile = process.env.JUNE_SETTINGS_FILE?.trim() || undefined;

  // Generic MCP capabilities (Phase 13). The host serializes the user's server
  // list into JUNE_MCP_SERVERS; we coerce it (defensively), then keep only the
  // enabled servers the privacy mode allows (a networked capability is dropped
  // under strict-offline). Per-server class overrides feed the policy gate so an
  // inspected read-only server stops nagging while unknown tools still fail closed.
  const mcpEntries = resolveMcpEntries(parseMcpServers(process.env.JUNE_MCP_SERVERS), mode ?? "standard");
  setServerDefaults(serverDefaults(mcpEntries));
  // Server ids that reach the network - blocked even for observe-class reads on an
  // unattended run (B1.3), so a promoted search server can't exfiltrate unwatched.
  const networkedServers = new Set(mcpEntries.filter((e) => !e.offlineSafe).map((e) => e.id));

  const agent = createJuneAgent({
    ...brain,
    workspaceId: process.env.JUNE_WORKSPACE_ID ?? "june",
    filesRoot,
    memoryFile,
    memory,
    lessonsFile,
    hasLessons,
    settingsFile,
    mcpEntries,
    persistSession,
  });

  // Serialize turns: only one runs at a time. `activeTurn` is the turn currently
  // executing (or null); a new `run` preempts it. `chain` is the tail of the
  // run queue so a preempting run starts only after the prior turn unwinds.
  let activeTurn: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  async function runTurn(turn: number, transcript: string, run: RunRequest): Promise<void> {
    activeTurn = turn;
    try {
      if (brainBlocked) {
        emit({ t: "final", turn, text: brainBlocked, isError: true });
        return;
      }
      const text = transcript.trim();
      if (!text) {
        emit({ t: "final", turn, text: "I did not catch a command.", isError: true });
        return;
      }
      // Unattended runs (18.2/18.3) are framed: the task is wrapped with a "no one
      // is watching" header, and a trigger's untrusted payload is fenced off as
      // data-to-investigate, never instructions (the gate is the real leash).
      const framed = run.unattended
        ? frameUnattended(text, run.source ?? "unattended", run.untrusted)
        : text;
      // Pre-run recall (17.2): inject the top-k lessons relevant to this task. Read
      // fresh so a lesson recorded earlier this session is available now.
      const prompt = withRecalledLessons(framed, await readLessons(lessonsFile));
      const result = await agent.run(prompt, {
        gate: hub.makeGate(turn, run.unattended, networkedServers),
        onText: (delta) => emit({ t: "text", turn, delta }),
        onToolUse: (c) => emit({ t: "tool", turn, action: c.action, input: c.input }),
        onToolResult: (action, res, isError) => emit({ t: "result", turn, action, res, isError }),
      });
      emit({ t: "final", turn, text: result.text, isError: result.isError, usage: result.usage });
    } catch (e) {
      emit({
        t: "final",
        turn,
        text: `June hit an error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      });
    } finally {
      hub.denyWaitersFor(turn);
      if (activeTurn === turn) activeTurn = null;
    }
  }

  function handleRun(run: RunRequest): void {
    const turn = run.turn;
    // Preempt an active turn (barge-in) so the new command never queues behind an
    // abandoned one: cancel the brain and self-deny the old turn's pending gate,
    // then chain this turn after the old one unwinds.
    if (activeTurn !== null && activeTurn !== turn) {
      agent.cancel();
      hub.denyWaitersFor(activeTurn);
    }
    chain = chain.then(() => runTurn(turn, run.transcript ?? "", run));
  }

  const reader: Interface = createInterface({ input: stdin });
  reader.on("line", (line) => {
    const req = parseRequest(line);
    if (!req) return; // non-JSON noise or an unrecognized type - ignore (2.9)
    switch (req.type) {
      case "run":
        if (typeof req.turn === "number") handleRun(req);
        break;
      case "approve":
        if (typeof req.approvalId === "number") hub.resolveApproval(req.approvalId, req.decision === "allow");
        break;
      case "cancel":
        if (typeof req.turn === "number") {
          if (activeTurn === req.turn) agent.cancel();
          hub.denyWaitersFor(req.turn);
        }
        break;
      case "reset":
        agent.reset();
        break;
    }
  });
  // Stdin closing means the host is gone: dispose warm resources and exit.
  reader.on("close", () => {
    void agent.dispose().finally(() => process.exit(0));
  });

  emit({ t: "ready" });
}

main().catch((e) => {
  emit({ t: "error", text: `June serve failed to start: ${e instanceof Error ? e.message : String(e)}` });
  process.exit(1);
});
