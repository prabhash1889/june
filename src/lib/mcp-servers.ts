// Generic MCP client & capability manager (improvement-4 Phase 13). This is the
// decoupling step: a user adds a capability (any MCP server) from settings, June
// runs it - zero June code changes. saple-bridge becomes list entry #1, not the
// core.
//
// This module is deliberately tauri-free AND agent-SDK-free so BOTH sides can
// share it: the frontend settings UI edits the list, and the resident agent
// (agent/serve.ts) resolves it into MCP configs. The one source of truth for a
// user-added server lives here - its schema, its privacy rule, its config
// mapping, and the curated catalog - so neither side re-implements it.

import { type PrivacyMode } from "./privacy.ts";

/** Safety class union, kept in step with agent/policy.ts's SafetyClass (structural
 *  match, no cross-import so the frontend never pulls in the agent module). A
 *  per-server default lets the user promote a whole server's tools to a lower
 *  class after inspecting them once (13.2); absent -> the fail-closed default. */
export type McpClass = "observe" | "reversible" | "expensive" | "destructive";

/** How June reaches a server: a local stdio subprocess, or a remote HTTP MCP
 *  endpoint. (SSE-only servers are rare now; add when one shows up - YAGNI.) */
export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> };

/** One user-added capability. `id` doubles as the MCP server name, so it appears
 *  in tool names as `mcp__<id>__<tool>` - it must be a plain slug (no `__`, which
 *  the policy layer splits on). */
export interface McpServerEntry {
  id: string;
  label: string;
  enabled: boolean;
  transport: McpTransport;
  /** Runs entirely on-device (no network). Feeds the same privacy enforcement as
   *  provider `offlineSafe` (13.1): a networked server is dropped under strict
   *  offline. A stdio server is not automatically offline-safe (it may itself
   *  call the network), so the user declares this per server. */
  offlineSafe: boolean;
  /** Per-server default safety class for tools not otherwise classified (13.2).
   *  Undefined -> policy's fail-closed default (unknown tool = gated). */
  defaultClass?: McpClass;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Server ids June reserves for its own built-in capabilities (B1.5). A user-added
 *  entry claiming one of these would SHADOW the trusted server (e.g. its arbitrary
 *  `remember` inheriting the built-in ungated class), so such an entry is dropped.
 *  Kept in step with agent/policy.ts's BUILTIN_SERVERS. */
const RESERVED_IDS: ReadonlySet<string> = new Set([
  "memory",
  "lessons",
  "files",
  "saple-bridge-control",
  "automation",
  "system",
]);

/** Turn a label into a safe server id/slug: lowercase, non-alphanumerics to `-`,
 *  trimmed. Used when the caller doesn't supply an id. */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function strMap(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const CLASSES: McpClass[] = ["observe", "reversible", "expensive", "destructive"];

/** Coerce one raw object into a valid entry, or null if it can't be salvaged (a
 *  server with no usable transport or id is dropped rather than half-run). */
function coerceEntry(raw: unknown): McpServerEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : "";
  const idRaw = typeof r.id === "string" ? r.id : "";
  const id = SLUG.test(idRaw) ? idRaw : slugify(label || idRaw);
  if (!id) return null;
  if (RESERVED_IDS.has(id)) return null; // can't shadow a built-in server (B1.5)

  const t = (typeof r.transport === "object" && r.transport !== null ? r.transport : {}) as Record<string, unknown>;
  let transport: McpTransport | null = null;
  if (t.kind === "http" && typeof t.url === "string" && t.url.trim()) {
    transport = { kind: "http", url: t.url.trim(), headers: strMap(t.headers) };
  } else if (typeof t.command === "string" && t.command.trim()) {
    transport = { kind: "stdio", command: t.command.trim(), args: strArr(t.args), env: strMap(t.env) };
  }
  if (!transport) return null;

  const dc = r.defaultClass;
  return {
    id,
    label: label || id,
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    transport,
    offlineSafe: r.offlineSafe === true,
    ...(CLASSES.includes(dc as McpClass) ? { defaultClass: dc as McpClass } : {}),
  };
}

/** Coerce an arbitrary bag (settings.json value, or a JSON env string already
 *  parsed) into a clean, de-duplicated entry list. Tolerant by design: a bad
 *  entry is dropped, never fatal. Later duplicate ids win (last edit wins). */
export function coerceMcpServers(raw: unknown): McpServerEntry[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, McpServerEntry>();
  for (const item of raw) {
    const e = coerceEntry(item);
    if (e) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/** Whether a server may run under a privacy mode (13.1). Only strict-offline
 *  drops networked servers; local-voice constrains voice, not the agent's tools
 *  (its brain may already use the network), so an MCP server is allowed there. */
export function mcpServerAllowed(mode: PrivacyMode, entry: McpServerEntry): boolean {
  return mode !== "strict-offline" || entry.offlineSafe;
}

/** The servers that should actually be connected this run: enabled and allowed
 *  by the privacy mode. Pure, so the resolve step is unit-tested without a live
 *  agent. */
export function resolveMcpEntries(entries: McpServerEntry[], mode: PrivacyMode): McpServerEntry[] {
  return entries.filter((e) => e.enabled && mcpServerAllowed(mode, e));
}

/** The per-server class overrides, for policy.setServerDefaults (13.2). Only
 *  entries that declared a default appear. */
export function serverDefaults(entries: McpServerEntry[]): Record<string, McpClass> {
  const out: Record<string, McpClass> = {};
  for (const e of entries) if (e.defaultClass) out[e.id] = e.defaultClass;
  return out;
}

/** An MCP server config in the shape the Agent SDK (and our OpenAI-compat MCP
 *  client) accept. Structurally matches the SDK's McpServerConfig union; typed
 *  loosely here so this shared module needn't import the agent SDK. */
export type McpServerConfigLike =
  | { command: string; args: string[]; env: Record<string, string>; alwaysLoad: true }
  | { type: "http"; url: string; headers: Record<string, string>; alwaysLoad: true };

/** Brain-provider secrets the resident carries in its own env (ANTHROPIC_API_KEY for
 *  Claude, JUNE_BRAIN_API_KEY for the other brains; OPENAI_API_KEY defensively). No
 *  MCP child server ever needs them, but the Claude Agent SDK spawns MCP children with
 *  the resident's FULL env (its bundle has no inherit-allowlist, unlike the standalone
 *  MCP SDK the OpenAI brain uses), so a hostile or buggy server could read the key
 *  straight out of process.env. Blank them in every server's config env (7.9): under a
 *  full-env spawner the "" overrides the real secret; under an allowlist spawner it's a
 *  harmless empty var. Blank, never DELETE - deleting would also strip PATH/APPDATA and
 *  break `npx`. */
export const SCRUBBED_BRAIN_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  JUNE_BRAIN_API_KEY: "",
};

/** A server's config env with the brain secrets blanked underneath it (7.9); the
 *  server's own vars win over the blanks. */
export function scrubbedEnv(delta: Record<string, string> = {}): Record<string, string> {
  return { ...SCRUBBED_BRAIN_ENV, ...delta };
}

/** Map one entry to its MCP server config. `alwaysLoad` keeps the tools in the
 *  prompt (like June's built-in servers) so a brain with no tool-search can still
 *  call them. The stdio env is scrubbed of brain secrets (7.9). */
export function toMcpServerConfig(entry: McpServerEntry): McpServerConfigLike {
  const t = entry.transport;
  if (t.kind === "http") {
    return { type: "http", url: t.url, headers: t.headers, alwaysLoad: true };
  }
  return { command: t.command, args: t.args, env: scrubbedEnv(t.env), alwaysLoad: true };
}

/** The generic servers as an id -> config map, ready to merge into the agent's
 *  mcpServers (agent/core.ts). */
export function genericMcpServers(entries: McpServerEntry[]): Record<string, McpServerConfigLike> {
  const out: Record<string, McpServerConfigLike> = {};
  for (const e of entries) out[e.id] = toMcpServerConfig(e);
  return out;
}

// --- Curated catalog (13.4) ------------------------------------------------
// Maturity-ranked, ready-to-add presets. Versions are PINNED (13.5 supply-chain
// vetting: an unpinned `npx <server>` pulls latest, the typosquat/rug-pull
// surface). `offlineSafe` is honest per server; `defaultClass` pre-declares the
// riskiest tool class so a write still gets gated but reads don't nag.

export interface CatalogPreset {
  entry: McpServerEntry;
  /** One line shown in the picker: what it does + any caveat. */
  note: string;
}

export const MCP_CATALOG: CatalogPreset[] = [
  {
    note: "GitHub: list/read issues & PRs by voice; writes are gated.",
    entry: {
      id: "github",
      label: "GitHub",
      enabled: true,
      offlineSafe: false,
      // Reads are safe to auto-run; the model's write tools still fail closed to
      // gated per-action, so a whole-server default of reversible is wrong. Leave
      // it unset -> unknown tools gated; the user promotes reads after inspecting.
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
      },
    },
  },
  {
    // Phase 17.3: saple-memory attaches purely as a Phase 13 config entry - no
    // June code. It is the SAPLE project's own local memory store (a compiled
    // stdio binary), so it is offline-safe. It mixes reads with local writes and
    // deletes, so `defaultClass` is left unset - unknown tools stay gated until
    // the user inspects them and promotes reads, the same stance as GitHub.
    note: "saple-memory: SAPLE's local task/incident/memory store. Set the command to your saple-mcp binary and the arg to your workspace folder.",
    entry: {
      id: "saple-memory",
      label: "saple-memory",
      enabled: true,
      offlineSafe: true, // local DB, no network
      transport: {
        kind: "stdio",
        command: "saple-mcp",
        args: [],
        env: {},
      },
    },
  },
  {
    note: "Brave Search: web search for non-Claude brains (Claude has WebSearch built in).",
    entry: {
      id: "brave-search",
      label: "Brave Search",
      enabled: true,
      offlineSafe: false,
      defaultClass: "observe", // search is read-only
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search@0.6.2"],
        env: { BRAVE_API_KEY: "" },
      },
    },
  },
  {
    // improvement-6 4.8: a read-only page reader so a non-Claude brain (which lacks
    // Claude's built-in WebFetch) can "read me that article". Official reference
    // fetch server (Python, run via uvx - needs `uv` installed). Read-only, so the
    // whole server is safe to auto-run -> defaultClass observe; still networked, so
    // it is dropped under strict offline and blocked on unattended runs (exfil).
    note: "Fetch: read a web page's text for a non-Claude brain (Claude has WebFetch built in). Needs `uv` (uvx) installed.",
    entry: {
      id: "fetch",
      label: "Fetch (web page reader)",
      enabled: true,
      offlineSafe: false,
      defaultClass: "observe", // fetching a page is read-only
      transport: {
        kind: "stdio",
        command: "uvx",
        args: ["mcp-server-fetch@2026.7.10"],
        env: {},
      },
    },
  },
  {
    // improvement-6 4.8: a read-only calendar so the 9am briefing (and "what's on my
    // calendar today") has something personal to say. taylorwilsdon/google_workspace_mcp
    // scoped to calendar and started in --read-only mode (write tools disabled), so
    // the whole server is safe reads -> defaultClass observe. Google's API is
    // networked (offlineSafe false), so it is unavailable under strict offline and
    // an unattended briefing still can't call it (networked observe is blocked) -
    // calendar reads happen when the user is present. Fill in the OAuth env from a
    // Google Cloud OAuth client.
    note: "Google Calendar (read-only): 'what's on my calendar today'. Needs `uv` (uvx) and a Google OAuth client id/secret.",
    entry: {
      id: "google-calendar",
      label: "Google Calendar (read-only)",
      enabled: true,
      offlineSafe: false,
      defaultClass: "observe", // --read-only disables every write tool
      transport: {
        kind: "stdio",
        command: "uvx",
        args: ["workspace-mcp@1.22.0", "--tools", "calendar", "--read-only"],
        env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
      },
    },
  },
  {
    // improvement-6 4.8: the full Google Workspace preset improvement-4's acceptance
    // scenario assumes (Gmail/Calendar/Drive/Docs). Unlike the calendar entry above
    // this includes WRITE tools (send email, create event), so `defaultClass` is
    // left UNSET - unknown tools fail closed to gated, and the user promotes the
    // read tools after inspecting them (same stance as GitHub). `--tool-tier core`
    // keeps the surface to the essential tools.
    note: "Google Workspace (Gmail/Calendar/Drive/Docs): reads auto after you promote them; sends/writes stay gated. Needs `uv` (uvx) and a Google OAuth client id/secret.",
    entry: {
      id: "google-workspace",
      label: "Google Workspace",
      enabled: false, // opt-in - a broad, write-capable surface; enable when wanted
      offlineSafe: false,
      transport: {
        kind: "stdio",
        command: "uvx",
        args: ["workspace-mcp@1.22.0", "--tool-tier", "core"],
        env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
      },
    },
  },
  {
    note: "Playwright (browser automation): heavy (~100k tokens/task) - enable only on demand.",
    entry: {
      id: "playwright",
      label: "Playwright",
      enabled: false, // on-demand only - never in the default voice tool surface
      offlineSafe: false,
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.41"],
        env: {},
      },
    },
  },
];
