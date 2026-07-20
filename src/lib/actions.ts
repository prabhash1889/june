// Humanized tool names for the conversation surfaces (improvement-5 P2 6.7):
// `mcp__files__read_file` reads as "read file", not raw snake_case. Mirrors
// agent/policy.ts parseToolName - the server segment is parsed FROM THE FRONT
// and the tool kept whole - so the shown name is the same tool the policy
// classified. Display only; never used for any safety decision.

/** "mcp__<server>__<tool>" -> "tool with spaces"; a bare name just loses its
 *  underscores. Falls back to the input if stripping leaves nothing. */
export function humanizeAction(toolName: string): string {
  let tool = toolName;
  if (tool.startsWith("mcp__")) {
    const rest = tool.slice("mcp__".length);
    const sep = rest.indexOf("__");
    tool = sep >= 0 ? rest.slice(sep + 2) : rest;
  }
  return tool.replace(/_+/g, " ").trim() || toolName;
}
