// The agent core (PLAN.md §3, Phase 3). Assembles a Brain with its capabilities
// (MCP servers) and the voice-tuned prompt, and hands callers a single `run`.
// The orchestrator owns the capability list and the approval gate; the brain is
// swappable underneath. saple-bridge-control is the one committed capability -
// saple-memory / artemis attach later as extra config entries, never new code.

import { fileURLToPath } from "node:url";

import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { genericMcpServers, type McpServerEntry } from "../src/lib/mcp-servers.ts";
import { type Brain, type TurnHooks, type TurnResult } from "./brain.ts";
import { ClaudeBrain } from "./claude-brain.ts";
import { OpenAiCompatBrain } from "./openai-brain.ts";
import { SYSTEM_PROMPT, withAutomations, withLessons, withMemory } from "./prompt.ts";

/** Absolute path to Phase 2's MCP server, resolved from this file so it works
 *  wherever June is launched from. */
function bridgeControlServerPath(): string {
  return fileURLToPath(new URL("../mcp/saple-bridge-control/server.ts", import.meta.url));
}

/** Absolute path to Phase 9's non-saple files capability. */
function filesServerPath(): string {
  return fileURLToPath(new URL("../mcp/files/server.ts", import.meta.url));
}

/** Absolute path to Phase 11.4's long-term memory capability. */
function memoryServerPath(): string {
  return fileURLToPath(new URL("../mcp/memory/server.ts", import.meta.url));
}

/** Absolute path to Phase 17.1's post-run lessons capability. */
function lessonsServerPath(): string {
  return fileURLToPath(new URL("../mcp/lessons/server.ts", import.meta.url));
}

/** Absolute path to improvement-5 P1.5's voice-automation capability. */
function automationServerPath(): string {
  return fileURLToPath(new URL("../mcp/automation/server.ts", import.meta.url));
}

/** The files capability (PLAN.md Phase 9), scoped to a single allowed root. Only
 *  attached when the user has enabled it and pointed it at a folder - proof that
 *  a capability is a server, not new core code. Local + offline-safe. */
export function filesMcpServer(root: string): Record<string, McpServerConfig> {
  return {
    files: {
      command: "npx",
      args: ["tsx", filesServerPath()],
      alwaysLoad: true,
      env: { ...process.env, JUNE_FILES_ROOT: root },
    },
  };
}

/** The long-term memory capability (PLAN.md Phase 11.4). Always attached when a
 *  memory file path is set: memory is local and user-visible, so it stays on in
 *  every privacy mode. The file need not exist yet - the remember tool creates it. */
export function memoryMcpServer(file: string): Record<string, McpServerConfig> {
  return {
    memory: {
      command: "npx",
      args: ["tsx", memoryServerPath()],
      // Keep the tool in the prompt (like the other servers) so the model with no
      // built-in tool-search can actually call `remember`.
      alwaysLoad: true,
      env: { ...process.env, JUNE_MEMORY_FILE: file },
    },
  };
}

/** The post-run lessons capability (improvement-4 Phase 17.1). Always attached
 *  when a lessons file path is set: lessons are local and user-visible, so like
 *  memory they stay on in every privacy mode. The file need not exist yet - the
 *  record_lesson tool creates it. Recall (17.2) happens per-turn in serve.ts, not
 *  here; this just gives the model the tool to write with. */
export function lessonsMcpServer(file: string): Record<string, McpServerConfig> {
  return {
    lessons: {
      command: "npx",
      args: ["tsx", lessonsServerPath()],
      // Keep the tool in the prompt (like the other servers) so the model with no
      // built-in tool-search can actually call `record_lesson`.
      alwaysLoad: true,
      env: { ...process.env, JUNE_LESSONS_FILE: file },
    },
  };
}

/** The voice-automation capability (improvement-5 P1.5). Attached when a settings
 *  file path is set: June can create scheduled runs and watch loops by voice. Local
 *  and user-visible (the automations show in settings), so like memory it stays on
 *  in every privacy mode; the add_* tools are gated in policy.ts so June never
 *  schedules itself without a yes. */
export function automationMcpServer(settingsFile: string): Record<string, McpServerConfig> {
  return {
    automation: {
      command: "npx",
      args: ["tsx", automationServerPath()],
      // Keep the tools in the prompt (like the other built-ins) so a brain with no
      // tool-search can actually call add_schedule / add_watch.
      alwaysLoad: true,
      env: { ...process.env, JUNE_SETTINGS_FILE: settingsFile },
    },
  };
}

/** The committed capability: the saple-bridge-control MCP server, run with tsx. */
export function defaultMcpServers(workspaceId?: string): Record<string, McpServerConfig> {
  return {
    "saple-bridge-control": {
      command: "npx",
      args: ["tsx", bridgeControlServerPath()],
      // Keep the tools in the prompt instead of deferred behind tool-search:
      // with no built-in tools the model has no search tool to discover them,
      // so without this it hallucinates tool names instead of calling ours.
      alwaysLoad: true,
      ...(workspaceId ? { env: { ...process.env, JUNE_WORKSPACE_ID: workspaceId } } : {}),
    },
  };
}

export interface JuneAgentOptions {
  /** Brain provider id (PLAN.md §3 roster). "claude" (or unset) uses the Agent
   *  SDK brain; every other id routes through the OpenAI-compatible brain. */
  provider?: string;
  model?: string;
  /** OpenAI-compatible endpoint root (non-Claude brains). */
  baseUrl?: string;
  /** Provider API key (non-Claude brains). Claude reads ANTHROPIC_API_KEY. */
  apiKey?: string;
  workspaceId?: string;
  /** Allowed root for the files capability (PLAN.md Phase 9). When set, the files
   *  MCP server is attached, scoped to this folder. Unset -> no filesystem access. */
  filesRoot?: string;
  /** Path to June's long-term memory file (PLAN.md Phase 11.4). When set, the
   *  memory MCP server is attached so June can save durable facts. Unset -> no
   *  remember tool. */
  memoryFile?: string;
  /** June's current long-term memory (the file's contents), injected into the
   *  system prompt so a preference stated in a past conversation is recalled. */
  memory?: string;
  /** Path to June's post-run lessons file (improvement-4 Phase 17.1). When set,
   *  the lessons MCP server is attached so June can save task lessons. Unset ->
   *  no record_lesson tool. Recall (17.2) is per-turn in serve.ts. */
  lessonsFile?: string;
  /** Whether June has any saved lessons yet (Phase 17). Drives one line of the
   *  system prompt so June knows to write lessons even before recall kicks in. */
  hasLessons?: boolean;
  /** Path to settings.json (improvement-5 P1.5). When set, the automation MCP
   *  server is attached so June can create schedules/watch loops by voice. Unset ->
   *  no automation tools. */
  settingsFile?: string;
  /** Extra MCP capabilities merged over the default (e.g. saple-memory). */
  extraMcpServers?: Record<string, McpServerConfig>;
  /** User-added capability servers (Phase 13). Each becomes an MCP server with
   *  zero core edits - the whole point of the generic client. Already filtered
   *  for enable + privacy by the caller (agent/serve.ts). */
  mcpEntries?: McpServerEntry[];
  /** When false, the Claude brain keeps no session history on disk (Phase 11.2:
   *  strict privacy modes). Defaults to true. */
  persistSession?: boolean;
}

export interface JuneAgent {
  brain: Brain;
  run(prompt: string, hooks: TurnHooks): Promise<TurnResult>;
  /** Abort the in-flight turn (barge-in / preemption). */
  cancel(): void;
  /** Start a fresh conversation, dropping accumulated history (Phase 11.2). */
  reset(): void;
  /** Release warm resources on shutdown. */
  dispose(): Promise<void>;
}

export function createJuneAgent(opts: JuneAgentOptions = {}): JuneAgent {
  const mcpServers = {
    ...defaultMcpServers(opts.workspaceId),
    ...(opts.filesRoot ? filesMcpServer(opts.filesRoot) : {}),
    ...(opts.memoryFile ? memoryMcpServer(opts.memoryFile) : {}),
    ...(opts.lessonsFile ? lessonsMcpServer(opts.lessonsFile) : {}),
    ...(opts.settingsFile ? automationMcpServer(opts.settingsFile) : {}),
    // User-added capabilities (Phase 13): merged like any other server. Adding a
    // capability is data here, not new code. Cast: the shared builder types the
    // config loosely (SDK-free) but the shape matches McpServerConfig exactly.
    ...(genericMcpServers(opts.mcpEntries ?? []) as Record<string, McpServerConfig>),
    ...opts.extraMcpServers,
  };
  const systemPrompt = withAutomations(
    withLessons(withMemory(SYSTEM_PROMPT, opts.memory), {
      enabled: Boolean(opts.lessonsFile),
      hasLessons: Boolean(opts.hasLessons),
    }),
    Boolean(opts.settingsFile),
  );
  const provider = opts.provider ?? "claude";
  const brain: Brain =
    provider === "claude"
      ? new ClaudeBrain({
          model: opts.model,
          systemPrompt,
          mcpServers,
          persistSession: opts.persistSession,
        })
      : new OpenAiCompatBrain({
          id: provider,
          model: opts.model ?? "",
          baseUrl: opts.baseUrl ?? "",
          apiKey: opts.apiKey,
          systemPrompt,
          mcpServers,
        });
  return {
    brain,
    run: (prompt, hooks) => brain.run(prompt, hooks),
    cancel: () => brain.cancel(),
    reset: () => brain.reset(),
    dispose: () => brain.dispose(),
  };
}
