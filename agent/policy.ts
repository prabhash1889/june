// Safety policy - the approval gate's brain-independent core (PLAN.md §5).
//
// The gate is classified *by action class, not by model*: swapping the
// coordinator brain (Claude -> GPT -> local) cannot skip a gate because the
// decision lives here, in June's execution layer, and is enforced at the tool
// dispatch point (agent/core.ts wires it into the SDK's canUseTool hook). The
// brain only ever proposes a tool call; this module decides whether it needs a
// human yes before it can run.

/** PLAN.md §5 action classes. */
export type SafetyClass = "observe" | "reversible" | "expensive" | "destructive";

/** Classes that require a human confirmation before the action runs. */
const GATED_CLASSES: readonly SafetyClass[] = ["expensive", "destructive"];

/**
 * Per-action class. Explicitly named actions get exactly this class; anything
 * NOT listed here (and not covered by a server default below) is treated as
 * `destructive` - fail-closed (10.1). An unknown tool is dangerous until a human
 * has classified it, so it needs a yes; the previous "unknown -> reversible"
 * default silently auto-ran novel tools, which is exactly the hole Phase 13's
 * add-any-server surface would have widened.
 */
const ACTION_CLASS: Record<string, SafetyClass> = {
  spawn_agents: "expensive", // launches paid agents - confirm with exact count
  assign_task: "expensive", // hands work to a running agent - paid, networked
  close_terminal: "destructive", // closes a terminal pane - confirm visibly
  // A `\n` in `data` runs whatever follows as a shell command in the pane, so
  // writing to a terminal is destructive, not reversible (10.1).
  send_to_terminal: "destructive",
  open_browser: "reversible", // opening/focusing a URL is auto - the conservative-but-not-paranoid case
  get_swarm_status: "observe", // read-only roster
  // files capability (Phase 9): reads are automatic; a write is an external
  // effect (§5) - it overwrites a file - so it must be confirmed before it runs.
  list_files: "observe",
  read_file: "observe",
  write_file: "destructive",
  // memory capability (Phase 11.4): saving a durable fact to the local, contained
  // memory file is auto - it is local-only and trivially reversible (the user can
  // edit or clear "what June remembers" in settings), so it needs no approval.
  remember: "reversible",
};

/**
 * Per-server default class for actions not named in `ACTION_CLASS` (10.1). Lets
 * a capability declare a whole server's default (e.g. a read-only server as
 * `observe`) without a core edit per tool. Phase 13's add-any-server surface
 * writes here; an unmapped server falls through to the fail-closed default.
 */
const SERVER_DEFAULT_CLASS: Record<string, SafetyClass> = {};

/** MCP tools arrive as `mcp__<server>__<action>`; recover the bare action. */
export function actionOf(toolName: string): string {
  const parts = toolName.split("__");
  return parts[parts.length - 1] ?? toolName;
}

/** Recover the server name from an MCP tool name (`mcp__<server>__<action>`);
 *  undefined for a bare/built-in tool with no server segment. */
export function serverOf(toolName: string): string | undefined {
  const parts = toolName.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? parts[1] : undefined;
}

/** Classify an action, fail-closed: a named action wins, then its server's
 *  declared default, then `destructive` (gated) for anything still unknown. */
export function classify(action: string, server?: string): SafetyClass {
  return ACTION_CLASS[action] ?? (server ? SERVER_DEFAULT_CLASS[server] : undefined) ?? "destructive";
}

/** Redact tool params for the audit log per privacy mode (10.7). Under any
 *  on-device mode, string values (file paths, terminal commands, dictated text)
 *  are replaced with a length marker so the audit records that a param was
 *  present without persisting its content; numbers/booleans (e.g. a spawn count)
 *  survive so the record stays useful. Standard mode logs params verbatim. */
export function redactParams(input: Record<string, unknown>, mode?: string): Record<string, unknown> {
  if (!mode || mode === "standard") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === "string" ? `[redacted ${v.length} chars]` : v;
  }
  return out;
}

export function isGated(cls: SafetyClass): boolean {
  return GATED_CLASSES.includes(cls);
}

/** One-line human-readable statement of exactly what will happen - the text a
 *  user approves against. Numbers are exact (§5: "spoken confirmation with
 *  exact count"); unknown actions still render something truthful. */
export function summarize(action: string, input: Record<string, unknown>): string {
  const s = (k: string, d = ""): string => (typeof input[k] === "string" ? (input[k] as string) : d);
  switch (action) {
    case "spawn_agents": {
      const count = Number(input.count ?? 1);
      const provider = s("provider", "claude");
      const model = s("model");
      // The count is the cost/network estimate the user approves against (§5,
      // Phase 7 "show estimated cost and network use before high-fan-out"). We
      // state the class (paid, networked), not a dollar figure - real per-token
      // cost is unknowable before the run. ponytail: a class, not a quote.
      return `Spawn ${count} ${provider}${model ? ` (${model})` : ""} agent${count === 1 ? "" : "s"} (paid, uses network)`;
    }
    case "close_terminal":
      return `Close terminal ${s("pane_id") || "?"}`;
    case "write_file":
      return `Write file ${s("path") || "?"}`;
    case "read_file":
      return `Read file ${s("path") || "?"}`;
    case "list_files":
      return `List files${input.subdir ? ` in ${s("subdir")}` : ""}`;
    case "assign_task":
      return `Assign a task to agent ${s("agent_id") || "?"}`;
    case "send_to_terminal":
      return `Write to terminal ${s("pane_id") || "?"}`;
    case "open_browser":
      return `Open browser at ${s("url") || "?"}`;
    case "get_swarm_status":
      return "Read swarm status";
    case "remember":
      return `Remember: ${s("fact") || "?"}`;
    default:
      return `Run ${action}`;
  }
}
