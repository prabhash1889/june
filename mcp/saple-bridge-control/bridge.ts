// Transport to the saple-bridge June control endpoint (PLAN.md Phase 1/2).
//
// The MCP server (server.ts) is a thin proxy: it turns a tool call into a
// contract `command` and returns bridge's response verbatim. This module owns
// the two things that stand between the two - finding a live bridge (the
// discovery record) and speaking its localhost HTTP endpoint. Nothing here
// interprets a command result; error codes and batch counts pass straight up.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, type Action } from "../../src/contract/types.ts";

/** The record bridge writes on start (june_control.rs `write_discovery_record`). */
export interface Discovery {
  endpoint: string;
  token: string;
  pid: number;
  protocol_version: number;
  version: string;
}

/**
 * Every reason we can't reach a usable bridge collapses to one contract error
 * code. Tools surface it verbatim so an MCP client sees why (missing record,
 * stale pid, wrong protocol, socket refused) without special-casing transport.
 */
export class BridgeUnavailable extends Error {
  readonly code = "bridge_unavailable" as const;
}

/** `%APPDATA%\ai.saple.bridge` on Windows, `~/.config/ai.saple.bridge` elsewhere
 *  - kept in lockstep with bridge's `config_dir()`. */
export function discoveryPath(): string {
  const dir =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? "", "ai.saple.bridge")
      : join(homedir(), ".config", "ai.saple.bridge");
  return join(dir, "june-control.json");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, kills nothing
    return true;
  } catch (e) {
    // EPERM means the process exists but we may not signal it - still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read and vet the discovery record. Rejects a missing/corrupt record, a
 * protocol mismatch, and - like the Phase 1 smoke test - a stale record whose
 * process is gone. Throws `BridgeUnavailable` in every failure case.
 */
export function readDiscovery(path = discoveryPath()): Discovery {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new BridgeUnavailable(
      `no bridge discovery record at ${path} - is saple-bridge running with "June Voice Control" enabled and restarted?`,
    );
  }
  let d: Discovery;
  try {
    d = JSON.parse(raw) as Discovery;
  } catch {
    throw new BridgeUnavailable(`bridge discovery record at ${path} is corrupt`);
  }
  if (d.protocol_version !== CONTRACT_VERSION)
    throw new BridgeUnavailable(
      `bridge speaks protocol v${d.protocol_version}, this server expects v${CONTRACT_VERSION}`,
    );
  if (!pidAlive(d.pid))
    throw new BridgeUnavailable(`bridge discovery record is stale (pid ${d.pid} not running)`);
  return d;
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  const d = readDiscovery();
  let res: Response;
  try {
    res = await fetch(`${d.endpoint}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${d.token}`, ...init.headers },
    });
  } catch (e) {
    throw new BridgeUnavailable(
      `cannot reach bridge at ${d.endpoint}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // The endpoint puts contract errors in a 200 body; only transport faults are 4xx/5xx.
  if (res.status === 401)
    throw new BridgeUnavailable("bridge rejected the discovery token (stale record - restart June control?)");
  if (!res.ok) throw new BridgeUnavailable(`bridge returned HTTP ${res.status}`);
  return res.json();
}

export function capabilities(): Promise<unknown> {
  return call("/capabilities", { method: "GET" });
}

export interface CommandRequestBody {
  request_id: string;
  workspace_id: string;
  action: Action;
  arguments: Record<string, unknown>;
}

/** POST a command; returns bridge's `CommandResponse` value untouched. */
export function command(body: CommandRequestBody): Promise<unknown> {
  return call("/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
