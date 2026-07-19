#!/usr/bin/env node
// One-shot, machine-readable harness over the same agent core the text CLI drives
// (PLAN.md Phase 3: "the same core the app UI and the voice pipeline drive - only
// the input/output surface differs"). Phase 4's voice pipeline runs June from the
// Tauri app: the Rust backend spawns this with the accepted transcript, reads the
// final line, and shows June's reply. Output is JSONL on stdout so the surface is
// parseable instead of ANSI text.
//
//   npx tsx agent/run-once.ts "what is the status of the swarm"
//   -> {"t":"final","text":"...","isError":false}
//
// Gate policy is fail-closed by default: gated (expensive/destructive) actions are
// DENIED unless JUNE_APPROVE=allow. The voice approval UI is the deferred Phase 3
// app-stream tail (built in Phase 6); until it exists, voice cannot silently spawn
// paid agents - only observe/reversible actions run automatically (PLAN.md §5).

import { stdout } from "node:process";

import { type ToolGate } from "./brain.ts";
import { createJuneAgent } from "./core.ts";
import { isGated } from "./policy.ts";

function emit(obj: Record<string, unknown>): void {
  stdout.write(JSON.stringify(obj) + "\n");
}

function makeGate(): ToolGate {
  const approveAll = process.env.JUNE_APPROVE?.toLowerCase() === "allow";
  return async (call) => {
    if (!isGated(call.cls)) return { allow: true };
    if (approveAll) return { allow: true };
    return { allow: false, reason: "The user did not approve this action." };
  };
}

async function main(): Promise<void> {
  const transcript = process.argv.slice(2).join(" ").trim();
  if (!transcript) {
    emit({ t: "final", text: "I did not catch a command.", isError: true });
    return;
  }

  const agent = createJuneAgent({ workspaceId: process.env.JUNE_WORKSPACE_ID ?? "june" });
  const result = await agent.run(transcript, {
    gate: makeGate(),
    onText: (delta) => emit({ t: "text", delta }),
    onToolUse: (c) => emit({ t: "tool", action: c.action, input: c.input }),
    onToolResult: (action, res, isError) => emit({ t: "result", action, res, isError }),
  });
  emit({ t: "final", text: result.text, isError: result.isError });
}

main().catch((e) => {
  emit({ t: "final", text: `June hit an error: ${e instanceof Error ? e.message : String(e)}`, isError: true });
  process.exit(1);
});
