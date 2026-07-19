#!/usr/bin/env node
// One-shot, machine-readable harness over the same agent core the text CLI drives
// (PLAN.md Phase 3: "the same core the app UI and the voice pipeline drive - only
// the input/output surface differs"). The Tauri backend spawns this and streams
// its JSONL stdout to the voice surface.
//
// The transcript arrives as the FIRST JSONL line on stdin - `{"transcript":"..."}`
// (10.2) - NOT on the command line: a spoken command is untrusted text, and the
// Windows spawn goes through `cmd /C npx`, where a transcript in argv is an OS
// command-injection vector (a `&` or newline runs a second command). On stdin as
// a JSON string it is inert data. The same stdin channel then carries approval
// decisions for the rest of the turn.
//
//   printf '{"transcript":"what is the status of the swarm"}\n' | npx tsx agent/run-once.ts
//   -> {"t":"final","text":"...","isError":false}
//
// Phase 6 makes the approval gate interactive. Earlier phases were fail-closed
// (gated actions denied unless JUNE_APPROVE=allow) because no approval UI
// existed. Now, when a gated (expensive/destructive) action is proposed, this
// emits an `{"t":"approval",...}` line and BLOCKS on stdin until the host writes
// back `{"approvalId":n,"decision":"allow"|"deny"}`. The gate still lives in
// June's execution layer (PLAN.md §5) - the brain proposes, this decides - so it
// holds regardless of which brain is plugged in. It fails CLOSED: if no decision
// arrives (window closed), the action is denied after a timeout, never run.
//
// Every tool call - gated or not - is also written to stdout as an `{"t":"audit"}`
// line (10.7): action, class, redacted params, the decision, and who approved it
// (auto/policy/click/timeout/closed). The host stamps the turn id and appends it
// to the audit log. Phases 17-19 (unattended runs) stand on this record.
//
// JUNE_APPROVE (`allow`|`deny`) still forces a non-interactive policy for the
// headless/test path, taking precedence over the interactive channel.

import { type Interface, createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

import { type PrivacyMode, providerAllowed } from "../src/lib/privacy.ts";
import { resolveProvider } from "../src/lib/providers.ts";
import { type ToolGate } from "./brain.ts";
import { createJuneAgent } from "./core.ts";
import { isGated, redactParams } from "./policy.ts";

const PRIVACY_MODES: PrivacyMode[] = ["standard", "local-voice", "strict-offline"];

/** Resolve the brain the host (agent_runner.rs) selected via env into
 *  createJuneAgent options, defaulting to Claude. Base URL comes from the
 *  registry so it stays single-sourced; a custom endpoint overrides it. */
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

function emit(obj: Record<string, unknown>): void {
  stdout.write(JSON.stringify(obj) + "\n");
}

// Generous: a real person may take a while to decide. On expiry we deny, which
// implements §5's "approvals expire" as a safe default rather than a hang.
const APPROVAL_TIMEOUT_MS = 120_000;

const DENY_REASON = "The user did not approve this action.";

/** The approval reader over the shared stdin channel. The first stdin line (the
 *  transcript) is consumed by the caller before this attaches, so every line
 *  here is a `{approvalId, decision}`. `closed` flips when the host drops stdin
 *  (barge-in), which self-denies all waiters instead of hanging. */
interface DecisionChannel {
  waitFor(id: number): Promise<{ allow: boolean; approver: "click" | "timeout" | "closed" }>;
  closed: () => boolean;
}

function decisionChannel(reader: Interface): DecisionChannel {
  const waiters = new Map<number, (r: { allow: boolean; approver: "click" | "timeout" | "closed" }) => void>();
  let channelClosed = false;

  reader.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as { approvalId?: number; decision?: string };
      if (typeof msg.approvalId !== "number") return;
      const resolve = waiters.get(msg.approvalId);
      if (resolve) {
        waiters.delete(msg.approvalId);
        resolve({ allow: msg.decision === "allow", approver: "click" });
      }
    } catch {
      // Ignore non-JSON noise on the control channel.
    }
  });
  // The host dropped our stdin: this turn was barged in on and a newer turn took
  // the channel. No decision can ever arrive, so deny everything now.
  reader.on("close", () => {
    channelClosed = true;
    for (const [id, resolve] of waiters) {
      waiters.delete(id);
      resolve({ allow: false, approver: "closed" });
    }
  });

  return {
    closed: () => channelClosed,
    waitFor: (id) =>
      new Promise((resolve) => {
        waiters.set(id, resolve);
        const timer = setTimeout(() => {
          if (waiters.delete(id)) {
            // Tell the host the prompt is dead, so every window clears it - a
            // click after this point must not look like it was delivered.
            emit({ t: "approval-expired", id });
            resolve({ allow: false, approver: "timeout" });
          }
        }, APPROVAL_TIMEOUT_MS);
        timer.unref?.();
      }),
  };
}

/** Emit one audit line per tool call (10.7). Params are redacted per privacy mode
 *  before they ever reach the log. The host adds the turn id and timestamp of
 *  record; `ts` here is when the decision was made. */
function auditCall(
  call: Parameters<ToolGate>[0],
  decision: "allow" | "deny",
  approver: string,
  mode?: string,
): void {
  emit({
    t: "audit",
    tool: call.tool,
    action: call.action,
    cls: call.cls,
    params: redactParams(call.input, mode),
    decision,
    approver,
    ts: Date.now(),
  });
}

function makeGate(reader: Interface): ToolGate {
  const override = process.env.JUNE_APPROVE?.toLowerCase();
  const mode = process.env.JUNE_PRIVACY_MODE;
  const channel = decisionChannel(reader);
  let nextId = 1;

  return async (call) => {
    // Ungated actions run automatically, but are still audited (approver "auto").
    if (!isGated(call.cls)) {
      auditCall(call, "allow", "auto", mode);
      return { allow: true };
    }
    if (override === "allow") {
      auditCall(call, "allow", "policy", mode);
      return { allow: true };
    }
    if (override === "deny") {
      auditCall(call, "deny", "policy", mode);
      return { allow: false, reason: DENY_REASON };
    }
    if (channel.closed()) {
      auditCall(call, "deny", "closed", mode);
      return { allow: false, reason: DENY_REASON };
    }

    const id = nextId++;
    emit({ t: "approval", id, action: call.action, cls: call.cls, summary: call.summary });
    const { allow, approver } = await channel.waitFor(id);
    auditCall(call, allow ? "allow" : "deny", approver, mode);
    return allow ? { allow: true } : { allow: false, reason: DENY_REASON };
  };
}

/** Read the transcript from the first stdin line, sharing the same reader the
 *  gate then uses for decisions (10.2). Resolves to "" if stdin closes with no
 *  line, so a missing transcript surfaces the normal "didn't catch a command"
 *  path rather than hanging. */
function readTranscript(reader: Interface): Promise<string> {
  return new Promise((resolve) => {
    reader.once("line", (line) => {
      try {
        const msg = JSON.parse(line) as { transcript?: unknown };
        resolve(typeof msg.transcript === "string" ? msg.transcript.trim() : "");
      } catch {
        resolve("");
      }
    });
    reader.once("close", () => resolve(""));
  });
}

async function main(): Promise<void> {
  // One shared stdin reader: first line is the transcript, the rest are approval
  // decisions (10.2). Read the transcript before wiring the gate so its decision
  // listeners never see the transcript line.
  const reader = createInterface({ input: stdin });
  const transcript = await readTranscript(reader);
  if (!transcript) {
    emit({ t: "final", text: "I did not catch a command.", isError: true });
    return;
  }

  const brain = brainConfig();

  // Privacy enforcement at the execution boundary (PLAN.md §5), not just the
  // settings form: refuse a networked brain when the mode forbids it, so editing
  // settings.json can't smuggle a cloud brain past Strict offline.
  const mode = process.env.JUNE_PRIVACY_MODE as PrivacyMode | undefined;
  const p = resolveProvider("brain", brain.provider);
  if (p && mode && PRIVACY_MODES.includes(mode) && !providerAllowed(mode, "brain", p)) {
    emit({
      t: "final",
      text: `Privacy mode blocks the ${p.label} brain. Choose a local brain or change the mode in settings.`,
      isError: true,
    });
    return;
  }

  // The files capability (Phase 9) is attached only when the host passes a root
  // (user enabled it + chose a folder). It is local/offline-safe, so no privacy
  // mode blocks it - a Strict-offline session can still read and write files.
  const filesRoot = process.env.JUNE_FILES_ROOT?.trim() || undefined;

  const agent = createJuneAgent({
    ...brain,
    workspaceId: process.env.JUNE_WORKSPACE_ID ?? "june",
    filesRoot,
  });
  const result = await agent.run(transcript, {
    gate: makeGate(reader),
    onText: (delta) => emit({ t: "text", delta }),
    onToolUse: (c) => emit({ t: "tool", action: c.action, input: c.input }),
    onToolResult: (action, res, isError) => emit({ t: "result", action, res, isError }),
  });
  emit({ t: "final", text: result.text, isError: result.isError });
}

// Exit explicitly: the host keeps our stdin's write end open for the whole turn
// (that's the decision channel), so the readline never sees EOF. All output is
// emitted before we return, so exiting here is what lets the process end.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    emit({ t: "final", text: `June hit an error: ${e instanceof Error ? e.message : String(e)}`, isError: true });
    process.exit(1);
  });
