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
 * June's own built-in capability servers (B1.1). `ACTION_CLASS` below is trusted
 * ONLY for these (plus a bare, server-less tool): a third-party server naming a
 * tool `read_file` / `open_browser` / `remember` is a DIFFERENT tool that happens
 * to share a name, so it must never inherit June's built-in classification -
 * otherwise any generic server could ship an ungated `read_file` and dodge the
 * gate. Generic servers get only their declared per-server default, else fail
 * closed. Kept in step with the server ids reserved in mcp-servers.ts.
 */
const BUILTIN_SERVERS: ReadonlySet<string> = new Set([
  "saple-bridge-control",
  "files",
  "memory",
  "lessons",
  "automation",
]);

/** The memory/lessons write tools - blocked on unattended runs (B1.3) so an
 *  injection in a watched trigger can't persistently poison future prompts. */
const MEMORY_WRITE_ACTIONS: ReadonlySet<string> = new Set(["remember", "record_lesson"]);

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
  // lessons capability (Phase 17.1): saving a post-run lesson to the local,
  // contained lessons file is auto for the same reason as remember - local-only,
  // user-visible and editable in settings, trivially reversible.
  record_lesson: "reversible",
  // automation capability (improvement-5 P1.5): creating a scheduled run or a watch
  // loop is EXPENSIVE - it commits June to future unattended runs, so it needs a
  // yes (spoken-approvable, 14.2). Being gated also means an UNATTENDED run can't
  // create automations (18.2 blocks expensive), so a schedule can't spawn more of
  // itself. Listing is a read-only local observe.
  add_schedule: "expensive",
  add_watch: "expensive",
  list_automations: "observe",
};

/**
 * Per-server default class for actions not named in `ACTION_CLASS` (10.1). Lets
 * a capability declare a whole server's default (e.g. a read-only server as
 * `observe`) without a core edit per tool. Phase 13's add-any-server surface
 * writes here (via `setServerDefaults`); an unmapped server falls through to the
 * fail-closed default.
 */
let SERVER_DEFAULT_CLASS: Record<string, SafetyClass> = {};

/**
 * Register per-server default classes from user settings (Phase 13.2). A user who
 * has inspected a server's tools once can promote the whole server to a lower
 * class (e.g. a read-only search server -> `observe`), so its reads stop nagging
 * for approval - while any server left undeclared still fails closed to gated.
 * Replaces the map wholesale so a removed override actually takes effect.
 */
export function setServerDefaults(map: Record<string, SafetyClass>): void {
  SERVER_DEFAULT_CLASS = { ...map };
}

/** Split an MCP tool name into its server and tool, parsed FROM THE FRONT (B1.1):
 *  `mcp__<server>__<tool>` where `server` is the first segment after `mcp__` and
 *  `tool` is everything after it, VERBATIM (kept whole, even if it itself contains
 *  `__`). Parsing from the back instead let `mcp__evil__x__remember` masquerade as
 *  the built-in `remember`; keeping the tool whole makes it `x__remember`, which
 *  matches no built-in and fails closed. A bare name (no `mcp__` prefix) has no
 *  server and is the tool itself. */
export function parseToolName(toolName: string): { server?: string; tool: string } {
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep >= 0) return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
    return { tool: rest }; // malformed `mcp__foo` - no tool segment; treat as bare
  }
  return { tool: toolName };
}

/** The bare action (tool) name (`mcp__<server>__<tool>` -> `<tool>`, kept whole). */
export function actionOf(toolName: string): string {
  return parseToolName(toolName).tool;
}

/** Recover the server name from an MCP tool name; undefined for a bare tool. */
export function serverOf(toolName: string): string | undefined {
  return parseToolName(toolName).server;
}

/** Classify an action, fail-closed (B1.1): a named built-in action wins, but ONLY
 *  for June's own servers (or a bare tool) - a generic server never borrows a
 *  built-in class. Otherwise the server's declared default applies, else
 *  `destructive` (gated) for anything still unknown. */
export function classify(action: string, server?: string): SafetyClass {
  const builtin = server === undefined || BUILTIN_SERVERS.has(server);
  if (builtin) {
    const named = ACTION_CLASS[action];
    if (named) return named;
  }
  return (server ? SERVER_DEFAULT_CLASS[server] : undefined) ?? "destructive";
}

/** For an unattended run (B1.3 / Phase 18.2): decide whether a call may auto-run
 *  without a human. Only `observe`-class, LOCAL (non-networked), non-memory-writing
 *  tools are safe unattended - a reversible act (open a browser), a networked read
 *  (can exfiltrate via URL/params), or a memory/lessons write (persistent-injection
 *  poison) must be blocked, never auto-approved. Returns a short block reason, or
 *  null when the call is allowed. Pure, so it is unit-tested without the resident. */
export function unattendedBlockReason(
  call: { cls: SafetyClass; action: string; server?: string },
  networkedServers: ReadonlySet<string>,
): string | null {
  if (call.cls !== "observe") return "needs approval";
  if (call.server && networkedServers.has(call.server)) return "reaches the network";
  if (MEMORY_WRITE_ACTIONS.has(call.action)) return "writes persistent memory";
  return null;
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

/** Render a payload string for the approval card with control characters made
 *  VISIBLE (16.3): a `\n` in terminal `data` executes whatever follows as a shell
 *  command, so the approver must see the newline as `\n`, not as an invisible line
 *  break that hides the injected command. Long payloads keep their tail (where an
 *  injection hides) rather than being truncated away. */
export function showPayload(v: unknown): string {
  if (typeof v !== "string") return String(v ?? "");
  // Escape ALL Unicode control (Cc) and format (Cf) characters, not just \r\n\t
  // (B1.7): a zero-width space or an RTL-override (U+202E) can visually reorder or
  // hide the payload the user approves against, so every invisible char is made
  // visible. The common three keep their familiar `\n`-style escapes.
  return v.replace(/[\p{Cc}\p{Cf}]/gu, (ch) => {
    if (ch === "\r") return "\\r";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    return `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

/** The `: "<prompt>"` tail appended to an automation approval card (1.2). The
 *  prompt is what runs unattended on every fire, so the approver must see it -
 *  control chars visible, capped so a long prompt can't flood the card. Empty
 *  string when there is no prompt, so the card reads cleanly. */
function promptTail(prompt: string): string {
  if (!prompt.trim()) return "";
  const shown = showPayload(prompt);
  return `: "${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}"`;
}

/** One-line human-readable statement of exactly what will happen - the text a
 *  user approves against. Numbers are exact (§5: "spoken confirmation with
 *  exact count"); dangerous acts show their FULL parameters (16.3: the terminal
 *  text / assigned task, not just the pane/agent id); unknown actions still render
 *  something truthful. */
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
      // Expensive + can be spoken-approved (14.2): show the full task text so the
      // approver hears/sees exactly what work is handed to the agent (16.3).
      return `Assign to agent ${s("agent_id") || "?"}: ${showPayload(s("task")) || "?"}`;
    case "send_to_terminal":
      // Destructive: a `\n` in `data` runs a shell command. Show the full payload
      // with control chars visible so the injected command can't hide (16.3).
      return `Write to terminal ${s("pane_id") || "?"}: ${showPayload(s("data")) || "?"}`;
    case "open_browser":
      return `Open browser at ${s("url") || "?"}`;
    case "get_swarm_status":
      return "Read swarm status";
    case "remember":
      return `Remember: ${s("fact") || "?"}`;
    case "record_lesson":
      return `Note lesson: ${s("lesson") || "?"}`;
    case "add_schedule": {
      // Expensive + spoken-approvable (14.2): state exactly what recurring run the
      // user is authorizing, since it commits June to future unattended runs. Show
      // the PROMPT too (1.2): it is the payload that later runs unattended, so an
      // injected instruction hidden behind an innocent label must be visible to the
      // approver. Control chars made visible, capped so a huge blob can't flood.
      const label = s("label") || "a task";
      // A `once` reminder (4.1) is a one-shot, not an unattended run, so it reads as
      // a reminder on the card; daily/every still read as recurring unattended runs.
      if (s("kind") === "once") {
        return `Remind "${label}" once at ${s("at") || "?"}${promptTail(s("prompt"))}`;
      }
      const recur =
        s("kind") === "every"
          ? `every ${Number(input.everyMinutes ?? 0) || "?"} min`
          : `daily at ${s("time") || "?"}`;
      return `Schedule "${label}" to run ${recur} (unattended)${promptTail(s("prompt"))}`;
    }
    case "add_watch":
      return `Watch "${s("label") || "a task"}" every ${Number(input.everyMinutes ?? 0) || "?"} min${
        s("untilCondition") ? ` until ${showPayload(s("untilCondition"))}` : ""
      } (unattended)${promptTail(s("prompt"))}`;
    case "list_automations":
      return "List automations";
    default: {
      // An unknown gated tool (a generic server's action) still fails closed to
      // destructive, so the user WILL be asked to approve it - and must see what
      // they are approving (B1.6). Render its params with control chars visible,
      // capped so a huge blob can't flood the card.
      const params = showPayload(JSON.stringify(input));
      const shown = params.length > 300 ? `${params.slice(0, 300)}…` : params;
      return `Run ${action} ${shown}`;
    }
  }
}
