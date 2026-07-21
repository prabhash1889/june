// The June <-> saple-bridge control contract (PLAN.md §2, "The control contract").
//
// Frozen early and implementation-independent: June only ever speaks these three
// operations, so where authority lives in bridge (renderer dispatcher now, Rust
// later) never leaks to June. Bridge implements a matching Rust surface; the
// golden JSON in ./examples is the language-neutral source of truth both sides
// test against.
//
// The three operations:
//   capabilities()                                    -> Capabilities
//   command(CommandRequest)                           -> CommandResponse
//   observe(workspace_id, after_sequence)             -> ObserveResponse

export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Error codes (PLAN.md §6, Phase 1). This set is frozen: bridge never returns a
// code outside it, June handles each explicitly.
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "bridge_unavailable", // bridge process not reachable / not ready
  "stale_workspace", // workspace_id no longer open in bridge
  "denied_action", // action not permitted (policy / missing approval)
  "duplicate_request", // request_id already seen with a *different* payload
  "capacity", // limit hit (e.g. max concurrent agents)
  "provider_failure", // an underlying provider/tool failed
  "partial_batch_failure", // batch completed with some failures (see counts)
  "invalid_request", // malformed request / unknown action
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Actions. Grounded in the bridge store actions Phase 1 dispatches to
// (swarmStore / terminalStore / browserStore). `arguments` shape is per-action.
// ---------------------------------------------------------------------------

export const ACTIONS = [
  "spawn_agents", // batch spawn (provider/model/count/prompt) -> BatchCounts
  "assign_task", // give an existing agent a task
  "write_terminal", // write text to a terminal pane
  "close_terminal", // close a terminal pane
  "open_browser", // open/navigate a browser tab
  "close_browser", // close a browser tab
  "get_swarm_status", // observe: read the roster (non-mutating)
  "read_terminal", // observe: read a terminal pane's recent output (non-mutating)
] as const;

export type Action = (typeof ACTIONS)[number];

/** Actions that change state carry a request_id and are idempotent. */
export const MUTATING_ACTIONS: readonly Action[] = [
  "spawn_agents",
  "assign_task",
  "write_terminal",
  "close_terminal",
  "open_browser",
  "close_browser",
];

// ---------------------------------------------------------------------------
// capabilities()
// ---------------------------------------------------------------------------

export interface Capabilities {
  contract_version: number;
  bridge_version: string;
  actions: Action[];
  limits: {
    max_concurrent_agents: number;
    max_batch_size: number;
  };
}

// ---------------------------------------------------------------------------
// command()
// ---------------------------------------------------------------------------

/**
 * One-time approval token (PLAN.md §5). The bridge mints these and verifies the
 * exact action+arguments+nonce+expiry before executing a gated command; the
 * brain cannot fabricate or reuse one. June echoes the token it was handed.
 */
export interface ApprovalToken {
  nonce: string;
  action: Action;
  /** ms epoch after which the token is rejected. */
  expires_at: number;
}

export interface CommandRequest {
  /** Unique per mutating command; retrying with the same id is idempotent. */
  request_id: string;
  workspace_id: string;
  action: Action;
  // Per-action payload; validated bridge-side against the action.
  arguments: Record<string, unknown>;
  /** Present only for gated (expensive/destructive/external) actions. */
  approval?: ApprovalToken;
}

/** Partial success is first-class, not an error (PLAN.md §2). */
export interface BatchCounts {
  requested: number;
  started: number;
  failed: number;
  skipped: number;
}

export type CommandResponse =
  | {
      status: "accepted"; // long-running; watch observe() for completion
      request_id: string;
    }
  | {
      status: "result"; // completed synchronously
      request_id: string;
      // Action-specific payload; spawn_agents carries `counts`.
      result: Record<string, unknown> & { counts?: BatchCounts };
    }
  | {
      status: "error";
      request_id: string;
      error: { code: ErrorCode; message: string };
    };

// ---------------------------------------------------------------------------
// observe()
// ---------------------------------------------------------------------------

/**
 * Every state change carries a monotonically increasing `sequence`.
 * observe(after_sequence) resumes from the last acknowledged event, so a June
 * restart never loses the roster (PLAN.md §2).
 */
export interface Event {
  sequence: number;
  workspace_id: string;
  /** e.g. "agent.spawned", "agent.exited", "terminal.closed". Not enumerated
   *  in the contract: June routes on prefix and shows unknown kinds verbatim. */
  kind: string;
  /** Present when the event resulted from a command. */
  request_id?: string;
  payload: Record<string, unknown>;
}

export interface ObserveRequest {
  workspace_id: string;
  /** Return events strictly after this sequence; 0 for the full backlog. */
  after_sequence: number;
}

export interface ObserveResponse {
  workspace_id: string;
  events: Event[];
  /** Highest sequence bridge currently holds; lets June know if it is caught up. */
  latest_sequence: number;
}
