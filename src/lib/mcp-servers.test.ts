import { describe, expect, it } from "vitest";

import {
  coerceMcpServers,
  genericMcpServers,
  MCP_CATALOG,
  mcpServerAllowed,
  type McpServerEntry,
  resolveMcpEntries,
  serverDefaults,
  slugify,
  toMcpServerConfig,
} from "./mcp-servers.ts";

// The generic MCP capability model (Phase 13). These pin the coercion (a bad
// entry is dropped, never fatal), the privacy rule (networked servers off under
// strict-offline), and the config mapping - the load-bearing seam that lets a
// user add a server with zero June code.

const stdio = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({
  id: "github",
  label: "GitHub",
  enabled: true,
  offlineSafe: false,
  transport: { kind: "stdio", command: "npx", args: ["-y", "server"], env: {} },
  ...over,
});

describe("coerceMcpServers", () => {
  it("keeps a well-formed stdio entry and fills defaults", () => {
    const [e] = coerceMcpServers([
      { id: "github", label: "GitHub", transport: { command: "npx", args: ["-y", "s"] } },
    ]);
    expect(e).toMatchObject({
      id: "github",
      label: "GitHub",
      enabled: true, // defaults on when unspecified
      offlineSafe: false, // only true when explicitly true
      transport: { kind: "stdio", command: "npx", args: ["-y", "s"], env: {} },
    });
    expect(e.defaultClass).toBeUndefined();
  });

  it("keeps an http entry", () => {
    const [e] = coerceMcpServers([{ id: "remote", transport: { kind: "http", url: "https://x/mcp" } }]);
    expect(e.transport).toEqual({ kind: "http", url: "https://x/mcp", headers: {} });
  });

  it("drops entries with no usable transport or id", () => {
    expect(
      coerceMcpServers([
        { id: "no-transport" },
        { transport: { command: "npx" } }, // no id, no label -> no slug
        { id: "ok", transport: { command: "npx" } },
        "not-an-object",
        null,
      ]).map((e) => e.id),
    ).toEqual(["ok"]);
  });

  it("derives a slug id from the label when id is missing or unsafe", () => {
    const [e] = coerceMcpServers([{ label: "My Cool Server!", transport: { command: "run" } }]);
    expect(e.id).toBe("my-cool-server");
  });

  it("de-duplicates by id, last write wins", () => {
    const out = coerceMcpServers([
      { id: "a", label: "old", transport: { command: "x" } },
      { id: "a", label: "new", transport: { command: "y" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("new");
  });

  it("only accepts a valid defaultClass", () => {
    expect(coerceMcpServers([{ id: "a", defaultClass: "observe", transport: { command: "x" } }])[0].defaultClass).toBe("observe");
    expect(coerceMcpServers([{ id: "b", defaultClass: "bogus", transport: { command: "x" } }])[0].defaultClass).toBeUndefined();
  });

  it("returns [] for a non-array", () => {
    expect(coerceMcpServers(undefined)).toEqual([]);
    expect(coerceMcpServers({})).toEqual([]);
  });
});

describe("privacy enforcement", () => {
  it("drops a networked server under strict-offline but keeps an offline-safe one", () => {
    expect(mcpServerAllowed("strict-offline", stdio({ offlineSafe: false }))).toBe(false);
    expect(mcpServerAllowed("strict-offline", stdio({ offlineSafe: true }))).toBe(true);
  });

  it("allows a networked server under standard and local-voice (voice-only constraint)", () => {
    expect(mcpServerAllowed("standard", stdio())).toBe(true);
    expect(mcpServerAllowed("local-voice", stdio())).toBe(true);
  });

  it("resolveMcpEntries keeps only enabled + allowed servers", () => {
    const entries = [
      stdio({ id: "on", enabled: true, offlineSafe: true }),
      stdio({ id: "off", enabled: false, offlineSafe: true }),
      stdio({ id: "net", enabled: true, offlineSafe: false }),
    ];
    expect(resolveMcpEntries(entries, "strict-offline").map((e) => e.id)).toEqual(["on"]);
    expect(resolveMcpEntries(entries, "standard").map((e) => e.id)).toEqual(["on", "net"]);
  });
});

describe("policy + config mapping", () => {
  it("serverDefaults exposes only entries that declared a class", () => {
    expect(
      serverDefaults([stdio({ id: "a", defaultClass: "observe" }), stdio({ id: "b" })]),
    ).toEqual({ a: "observe" });
  });

  it("toMcpServerConfig maps stdio and http, always keeping tools in the prompt", () => {
    expect(toMcpServerConfig(stdio())).toEqual({ command: "npx", args: ["-y", "server"], env: {}, alwaysLoad: true });
    expect(
      toMcpServerConfig(stdio({ transport: { kind: "http", url: "https://x/mcp", headers: { A: "b" } } })),
    ).toEqual({ type: "http", url: "https://x/mcp", headers: { A: "b" }, alwaysLoad: true });
  });

  it("genericMcpServers keys configs by server id", () => {
    const map = genericMcpServers([stdio({ id: "github" }), stdio({ id: "brave" })]);
    expect(Object.keys(map).sort()).toEqual(["brave", "github"]);
  });
});

describe("slugify + catalog", () => {
  it("slugify makes a safe server id", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  --Trim-- ")).toBe("trim");
  });

  it("every catalog preset is a valid entry with a pinned version", () => {
    for (const { entry } of MCP_CATALOG) {
      // A preset must survive coercion unchanged in identity (it is already valid).
      expect(coerceMcpServers([entry])).toHaveLength(1);
      if (entry.transport.kind === "stdio") {
        // Pinned: at least one arg carries an @version (supply-chain vetting, 13.5).
        expect(entry.transport.args.some((a) => /@\d/.test(a))).toBe(true);
      }
    }
  });
});
