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
//     {"t":"final","turn":N,"text":...,"isError":...}
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

import { coerceMcpServers, resolveMcpEntries, serverDefaults } from "../src/lib/mcp-servers.ts";
import { type PrivacyMode, providerAllowed } from "../src/lib/privacy.ts";
import { resolveProvider } from "../src/lib/providers.ts";
import { type ToolGate } from "./brain.ts";
import { createJuneAgent } from "./core.ts";
import { isGated, redactParams, setServerDefaults } from "./policy.ts";

const PRIVACY_MODES: PrivacyMode[] = ["standard", "local-voice", "strict-offline"];

// Generous: a real person may take a while to decide. On expiry we deny, which
// implements §5's "approvals expire" as a safe default rather than a hang.
const APPROVAL_TIMEOUT_MS = 120_000;
const DENY_REASON = "The user did not approve this action.";

function emit(obj: Record<string, unknown>): void {
  stdout.write(JSON.stringify(obj) + "\n");
}

/** Parse the JUNE_MCP_SERVERS env (a JSON array of user-added servers, Phase 13)
 *  into raw objects for coercion. A missing/garbled value yields no servers - the
 *  built-in capabilities still work, so a bad list never breaks a turn. */
function parseMcpServers(raw: string | undefined): ReturnType<typeof coerceMcpServers> {
  if (!raw?.trim()) return [];
  try {
    return coerceMcpServers(JSON.parse(raw));
  } catch {
    return [];
  }
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

/** A gated tool call awaiting a decision, keyed by approval id and tagged with
 *  the turn that raised it (so cancelling a turn self-denies only its own). */
interface Waiter {
  turn: number;
  resolve: (r: { allow: boolean; approver: "click" | "timeout" | "closed" }) => void;
}

const waiters = new Map<number, Waiter>();
let nextApprovalId = 0;

/** Emit one audit line per tool call (10.7), params redacted per privacy mode. */
function auditCall(
  turn: number,
  call: Parameters<ToolGate>[0],
  decision: "allow" | "deny",
  approver: string,
  mode?: string,
): void {
  emit({
    t: "audit",
    turn,
    tool: call.tool,
    action: call.action,
    cls: call.cls,
    params: redactParams(call.input, mode),
    decision,
    approver,
    ts: Date.now(),
  });
}

/** The execution-layer gate for one turn. Ungated actions auto-run (still
 *  audited); gated ones emit an `approval` and block on a `{approve}` decision,
 *  failing closed on timeout. `JUNE_APPROVE` still forces a headless policy. */
function makeGate(turn: number): ToolGate {
  const override = process.env.JUNE_APPROVE?.toLowerCase();
  const mode = process.env.JUNE_PRIVACY_MODE;

  return async (call) => {
    if (!isGated(call.cls)) {
      auditCall(turn, call, "allow", "auto", mode);
      return { allow: true };
    }
    if (override === "allow") {
      auditCall(turn, call, "allow", "policy", mode);
      return { allow: true };
    }
    if (override === "deny") {
      auditCall(turn, call, "deny", "policy", mode);
      return { allow: false, reason: DENY_REASON };
    }

    const id = ++nextApprovalId;
    emit({ t: "approval", turn, id, action: call.action, cls: call.cls, summary: call.summary });
    const { allow, approver } = await new Promise<{
      allow: boolean;
      approver: "click" | "timeout" | "closed";
    }>((resolve) => {
      const timer = setTimeout(() => {
        if (waiters.delete(id)) {
          emit({ t: "approval-expired", turn, id });
          resolve({ allow: false, approver: "timeout" });
        }
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      waiters.set(id, {
        turn,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });
    auditCall(turn, call, allow ? "allow" : "deny", approver, mode);
    return allow ? { allow: true } : { allow: false, reason: DENY_REASON };
  };
}

/** Deny every pending approval raised by `turn` - used when a turn is cancelled
 *  or preempted so its blocked gate self-denies instead of hanging. */
function denyWaitersFor(turn: number): void {
  for (const [id, w] of waiters) {
    if (w.turn === turn) {
      waiters.delete(id);
      w.resolve({ allow: false, approver: "closed" });
    }
  }
}

async function main(): Promise<void> {
  const brain = brainConfig();

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
  // Strict privacy keeps nothing on disk: the Claude brain's session history is
  // not persisted under an on-device mode (Phase 11.2).
  const persistSession = !(mode === "strict-offline");

  // Long-term memory (Phase 11.4): the host points us at one june-memory.md; read
  // it once at spawn and inject it into the system prompt. A settings save or a
  // memory edit respawns the resident, so this stays current. Missing file -> no
  // memory yet, which is fine (the remember tool creates it on first use).
  const memoryFile = process.env.JUNE_MEMORY_FILE?.trim() || undefined;
  const memory = memoryFile ? await fs.readFile(memoryFile, "utf-8").catch(() => undefined) : undefined;

  // Generic MCP capabilities (Phase 13). The host serializes the user's server
  // list into JUNE_MCP_SERVERS; we coerce it (defensively), then keep only the
  // enabled servers the privacy mode allows (a networked capability is dropped
  // under strict-offline). Per-server class overrides feed the policy gate so an
  // inspected read-only server stops nagging while unknown tools still fail closed.
  const mcpEntries = resolveMcpEntries(parseMcpServers(process.env.JUNE_MCP_SERVERS), mode ?? "standard");
  setServerDefaults(serverDefaults(mcpEntries));

  const agent = createJuneAgent({
    ...brain,
    workspaceId: process.env.JUNE_WORKSPACE_ID ?? "june",
    filesRoot,
    memoryFile,
    memory,
    mcpEntries,
    persistSession,
  });

  // Serialize turns: only one runs at a time. `activeTurn` is the turn currently
  // executing (or null); a new `run` preempts it. `chain` is the tail of the
  // run queue so a preempting run starts only after the prior turn unwinds.
  let activeTurn: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  async function runTurn(turn: number, transcript: string): Promise<void> {
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
      const result = await agent.run(text, {
        gate: makeGate(turn),
        onText: (delta) => emit({ t: "text", turn, delta }),
        onToolUse: (c) => emit({ t: "tool", turn, action: c.action, input: c.input }),
        onToolResult: (action, res, isError) => emit({ t: "result", turn, action, res, isError }),
      });
      emit({ t: "final", turn, text: result.text, isError: result.isError });
    } catch (e) {
      emit({
        t: "final",
        turn,
        text: `June hit an error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      });
    } finally {
      denyWaitersFor(turn);
      if (activeTurn === turn) activeTurn = null;
    }
  }

  function handleRun(turn: number, transcript: string): void {
    // Preempt an active turn (barge-in) so the new command never queues behind an
    // abandoned one: cancel the brain and self-deny the old turn's pending gate,
    // then chain this turn after the old one unwinds.
    if (activeTurn !== null && activeTurn !== turn) {
      agent.cancel();
      denyWaitersFor(activeTurn);
    }
    chain = chain.then(() => runTurn(turn, transcript));
  }

  const reader: Interface = createInterface({ input: stdin });
  reader.on("line", (line) => {
    let req: { type?: string; turn?: number; transcript?: string; approvalId?: number; decision?: string };
    try {
      req = JSON.parse(line);
    } catch {
      return; // ignore non-JSON noise on the control channel
    }
    switch (req.type) {
      case "run":
        if (typeof req.turn === "number") handleRun(req.turn, req.transcript ?? "");
        break;
      case "approve": {
        if (typeof req.approvalId !== "number") break;
        const w = waiters.get(req.approvalId);
        if (w) {
          waiters.delete(req.approvalId);
          w.resolve({ allow: req.decision === "allow", approver: "click" });
        }
        break;
      }
      case "cancel":
        if (typeof req.turn === "number") {
          if (activeTurn === req.turn) agent.cancel();
          denyWaitersFor(req.turn);
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
