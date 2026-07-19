#!/usr/bin/env node
// Text-only harness for the June agent core (PLAN.md Phase 3: "prove the whole
// control loop, typed, no voice"). Type a command, watch June stream, approve
// gated actions at the prompt. This is the same core the app UI and (Phase 4+)
// the voice pipeline drive - only the input/output surface differs.
//
//   one-shot:      npx tsx agent/cli.ts "open five claude agents in this workspace"
//   interactive:   npx tsx agent/cli.ts

import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { type ToolGate } from "./brain.ts";
import { createJuneAgent } from "./core.ts";
import { isGated } from "./policy.ts";

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** The execution-layer gate: auto-allow reversible/observe actions, require a
 *  typed yes for gated (expensive/destructive) ones. The brain cannot reach a
 *  tool except through this - deny here and it does not run (Phase 3 exit).
 *
 *  Fails CLOSED: if we cannot obtain an answer (stdin closed, headless run with
 *  no policy), the action is denied, never silently allowed. `JUNE_APPROVE`
 *  (`allow`|`deny`) sets a non-interactive policy for headless use. */
function makeGate(rl: Interface): ToolGate {
  const policy = process.env.JUNE_APPROVE?.toLowerCase();
  return async (call) => {
    if (!isGated(call.cls)) return { allow: true };
    if (policy === "allow") return { allow: true };
    if (policy === "deny") return { allow: false, reason: "The user did not approve this action." };
    let answer: string;
    try {
      answer = (await rl.question(`\n${YELLOW}June wants to: ${call.summary}. Approve? (y/n) ${RESET}`))
        .trim()
        .toLowerCase();
    } catch {
      return { allow: false, reason: "No approval could be obtained, so the action was not run." };
    }
    if (answer === "y" || answer === "yes") return { allow: true };
    return { allow: false, reason: "The user did not approve this action." };
  };
}

async function runTurn(agent: ReturnType<typeof createJuneAgent>, rl: Interface, prompt: string): Promise<void> {
  const result = await agent.run(prompt, {
    gate: makeGate(rl),
    onText: (delta) => stdout.write(delta),
    onToolUse: (c) => stdout.write(`\n${DIM}[tool] ${c.action} ${JSON.stringify(c.input)}${RESET}\n`),
    onToolResult: (_action, res, isError) =>
      stdout.write(`${DIM}[result${isError ? " ERROR" : ""}] ${JSON.stringify(res)}${RESET}\n`),
  });
  stdout.write(`\n\n${CYAN}June: ${result.text}${RESET}\n`);
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const agent = createJuneAgent({ workspaceId: process.env.JUNE_WORKSPACE_ID ?? "june" });

  const oneShot = process.argv.slice(2).join(" ").trim();
  if (oneShot) {
    await runTurn(agent, rl, oneShot);
    rl.close();
    return;
  }

  stdout.write(`${CYAN}June agent (text mode). Type a command, or "exit" to quit.${RESET}\n`);
  for (;;) {
    const line = (await rl.question("\n> ")).trim();
    if (!line || line === "exit" || line === "quit") break;
    try {
      await runTurn(agent, rl, line);
    } catch (e) {
      stdout.write(`\n${YELLOW}error: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
    }
  }
  rl.close();
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
