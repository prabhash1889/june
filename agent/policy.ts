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
 * Per-action class. Actions not listed default to `reversible` (automatic) -
 * the conservative-but-not-paranoid stance §5 takes for open/focus style
 * operations. Anything that spends money or destroys state is named here.
 */
const ACTION_CLASS: Record<string, SafetyClass> = {
  spawn_agents: "expensive", // launches paid agents - confirm with exact count
  close_terminal: "destructive", // closes a terminal pane - confirm visibly
  get_swarm_status: "observe", // read-only roster
};

/** MCP tools arrive as `mcp__<server>__<action>`; recover the bare action. */
export function actionOf(toolName: string): string {
  const parts = toolName.split("__");
  return parts[parts.length - 1] ?? toolName;
}

export function classify(action: string): SafetyClass {
  return ACTION_CLASS[action] ?? "reversible";
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
    case "assign_task":
      return `Assign a task to agent ${s("agent_id") || "?"}`;
    case "send_to_terminal":
      return `Write to terminal ${s("pane_id") || "?"}`;
    case "open_browser":
      return `Open browser at ${s("url") || "?"}`;
    case "get_swarm_status":
      return "Read swarm status";
    default:
      return `Run ${action}`;
  }
}
