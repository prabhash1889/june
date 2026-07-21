import { describe, expect, it } from "vitest";

import {
  coerceMcpServers,
  genericMcpServers,
  isKeychainRef,
  KEYCHAIN_REF,
  MCP_CATALOG,
  mcpServerAllowed,
  type McpServerEntry,
  resolveMcpEntries,
  scrubbedEnv,
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

  it("drops an entry claiming a reserved built-in id (B1.5)", () => {
    // A user-added server with id `memory`/`lessons`/`files`/`saple-bridge-control`
    // would shadow the trusted built-in (its arbitrary `remember` inheriting the
    // ungated class). Such entries are dropped; a normal id beside them survives.
    expect(
      coerceMcpServers([
        { id: "memory", label: "evil", transport: { command: "x" } },
        { id: "lessons", transport: { command: "x" } },
        { id: "files", transport: { command: "x" } },
        { id: "saple-bridge-control", transport: { command: "x" } },
        { id: "system", transport: { command: "x" } },
        { id: "ok", transport: { command: "x" } },
      ]).map((e) => e.id),
    ).toEqual(["ok"]);
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
    // The stdio env now carries the blanked brain secrets (7.9) under any server env.
    expect(toMcpServerConfig(stdio())).toEqual({
      command: "npx",
      args: ["-y", "server"],
      env: { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", JUNE_BRAIN_API_KEY: "" },
      alwaysLoad: true,
    });
    expect(
      toMcpServerConfig(stdio({ transport: { kind: "http", url: "https://x/mcp", headers: { A: "b" } } })),
    ).toEqual({ type: "http", url: "https://x/mcp", headers: { A: "b" }, alwaysLoad: true });
  });

  it("genericMcpServers keys configs by server id", () => {
    const map = genericMcpServers([stdio({ id: "github" }), stdio({ id: "brave" })]);
    expect(Object.keys(map).sort()).toEqual(["brave", "github"]);
  });

  // 7.9: no MCP child should ever receive the brain API key. The Claude Agent SDK
  // spawns MCP children with the resident's full env (no allowlist), so every stdio
  // config blanks the known brain-key vars - a user's own env delta wins over the
  // blanks but can't accidentally leave a real key inherited.
  it("scrubs brain secrets from a user stdio server's env", () => {
    const cfg = toMcpServerConfig(stdio({ transport: { kind: "stdio", command: "npx", args: [], env: { FOO: "bar" } } }));
    expect(cfg).toMatchObject({
      env: { FOO: "bar", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", JUNE_BRAIN_API_KEY: "" },
    });
  });

  it("scrubbedEnv blanks the brain keys and lets the server's own vars win", () => {
    expect(scrubbedEnv()).toEqual({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", JUNE_BRAIN_API_KEY: "" });
    // A same-named delta var (unusual, but must win rather than be forced blank).
    expect(scrubbedEnv({ JUNE_MEMORY_FILE: "/m", OPENAI_API_KEY: "x" }).OPENAI_API_KEY).toBe("x");
    expect(scrubbedEnv({ JUNE_MEMORY_FILE: "/m" }).ANTHROPIC_API_KEY).toBe("");
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
      // Pinned: an npx/uvx preset pulls from a registry (npm/PyPI), so at least one
      // arg must carry an @version (supply-chain vetting, 13.5). A local binary
      // command (e.g. saple-memory's compiled saple-mcp, 17.3) has no registry
      // surface, so pinning does not apply there.
      if (entry.transport.kind === "stdio" && ["npx", "uvx"].includes(entry.transport.command)) {
        expect(entry.transport.args.some((a) => /@\d/.test(a))).toBe(true);
      }
    }
  });
});

describe("keychain reference", () => {
  it("KEYCHAIN_REF matches the sentinel Rust rehydrates (keychain.rs MCP_SENTINEL)", () => {
    // Cross-language contract: if this literal drifts from the Rust constant, saved
    // secrets stop resolving. Pin it so a rename can't silently break rehydration.
    expect(KEYCHAIN_REF).toBe("keychain:");
  });

  it("isKeychainRef flags only the sentinel, not a real or empty value", () => {
    expect(isKeychainRef(KEYCHAIN_REF)).toBe(true);
    expect(isKeychainRef("")).toBe(false);
    expect(isKeychainRef("ghp_realtoken")).toBe(false);
  });
});
