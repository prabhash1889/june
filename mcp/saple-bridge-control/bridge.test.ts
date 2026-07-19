// Discovery-record vetting is the one non-trivial bit of the transport: it is
// what keeps the MCP server from talking to a dead or wrong-protocol bridge.
// These run without a bridge (they only touch the filesystem gate).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "../../src/contract/types.ts";
import { BridgeUnavailable, readDiscovery } from "./bridge.ts";

const record = (over: Record<string, unknown> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "june-disc-"));
  const path = join(dir, "june-control.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoint: "http://127.0.0.1:1",
      token: "t",
      pid: process.pid, // our own pid is guaranteed alive
      protocol_version: CONTRACT_VERSION,
      version: "1.0.0",
      ...over,
    }),
  );
  return path;
};

describe("readDiscovery", () => {
  it("returns a live, current-protocol record", () => {
    const d = readDiscovery(record());
    expect(d.pid).toBe(process.pid);
    expect(d.protocol_version).toBe(CONTRACT_VERSION);
  });

  it("rejects a missing record as bridge_unavailable", () => {
    try {
      readDiscovery(join(tmpdir(), "does-not-exist-june.json"));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeUnavailable);
      expect((e as BridgeUnavailable).code).toBe("bridge_unavailable");
    }
  });

  it("rejects a protocol-version mismatch", () => {
    expect(() => readDiscovery(record({ protocol_version: CONTRACT_VERSION + 1 }))).toThrow(/protocol/);
  });

  it("rejects a stale record whose pid is gone", () => {
    // pid 2^31-1 is above the OS max and never assigned.
    expect(() => readDiscovery(record({ pid: 2147483647 }))).toThrow(/stale/);
  });
});
