#!/usr/bin/env node
// One-shot, machine-readable harness over the same agent core the text CLI drives
// (PLAN.md Phase 3: "the same core the app UI and the voice pipeline drive - only
// the input/output surface differs"). The Tauri backend spawns this with the
// accepted transcript and streams its JSONL stdout to the voice surface.
//
//   npx tsx agent/run-once.ts "what is the status of the swarm"
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
// JUNE_APPROVE (`allow`|`deny`) still forces a non-interactive policy for the
// headless/test path, taking precedence over the interactive channel.

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

import { type PrivacyMode, providerAllowed } from "../src/lib/privacy.ts";
import { resolveProvider } from "../src/lib/providers.ts";
import { type ToolGate } from "./brain.ts";
import { createJuneAgent } from "./core.ts";
import { isGated } from "./policy.ts";

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

function makeGate(): ToolGate {
  const override = process.env.JUNE_APPROVE?.toLowerCase();
  const waiters = new Map<number, (allow: boolean) => void>();
  let reader: ReturnType<typeof createInterface> | null = null;
  let channelClosed = false;
  let nextId = 1;

  // Open the decision channel lazily - a turn with no gated action never reads
  // stdin, so it can't be held open waiting for input that will never come.
  const ensureReader = (): void => {
    if (reader) return;
    reader = createInterface({ input: stdin });
    reader.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { approvalId?: number; decision?: string };
        if (typeof msg.approvalId !== "number") return;
        const resolve = waiters.get(msg.approvalId);
        if (resolve) {
          waiters.delete(msg.approvalId);
          resolve(msg.decision === "allow");
        }
      } catch {
        // Ignore non-JSON noise on the control channel.
      }
    });
    // The host dropped our stdin: this turn was barged in on and a newer turn
    // took the channel. No decision can ever arrive, so deny everything now
    // instead of hanging each gate for the full timeout.
    reader.on("close", () => {
      channelClosed = true;
      for (const [id, resolve] of waiters) {
        waiters.delete(id);
        resolve(false);
      }
    });
  };

  return async (call) => {
    if (!isGated(call.cls)) return { allow: true };
    if (override === "allow") return { allow: true };
    if (override === "deny") return { allow: false, reason: "The user did not approve this action." };

    ensureReader();
    if (channelClosed) return { allow: false, reason: "The user did not approve this action." };
    const id = nextId++;
    emit({ t: "approval", id, action: call.action, cls: call.cls, summary: call.summary });

    const allow = await new Promise<boolean>((resolve) => {
      waiters.set(id, resolve);
      const timer = setTimeout(() => {
        if (waiters.delete(id)) {
          // Tell the host the prompt is dead, so every window clears it - a
          // click after this point must not look like it was delivered.
          emit({ t: "approval-expired", id });
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
    });
    return allow ? { allow: true } : { allow: false, reason: "The user did not approve this action." };
  };
}

async function main(): Promise<void> {
  const transcript = process.argv.slice(2).join(" ").trim();
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

  const agent = createJuneAgent({ ...brain, workspaceId: process.env.JUNE_WORKSPACE_ID ?? "june" });
  const result = await agent.run(transcript, {
    gate: makeGate(),
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
