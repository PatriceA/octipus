/**
 * Swarm Phase 1 — public types.
 *
 * Mirrors the design in `.assistant/swarm-design.md`. Phase 1 covers
 * Orchestrator (depth 0) → Agent (depth 1) only; Subagent (depth 2) is
 * defined for forward compatibility but not spawnable yet.
 */

import type { AgentRole } from '@/core/orchestrator/types';

export type SwarmNodeKind = 'orchestrator' | 'agent' | 'subagent';

export type SwarmNodeStatus =
  | 'running'
  | 'completed'
  | 'budget'
  | 'timeout'
  | 'denied'
  | 'tool_error'
  | 'provider_error'
  | 'cancelled'
  | 'concurrency_limit'
  | 'cache_hit';

export type ChildResultStatus =
  | 'ok'
  | 'budget'
  | 'timeout'
  | 'tool_error'
  | 'provider_error'
  | 'cancelled'
  | 'denied'
  | 'concurrency_limit'
  | 'cache_hit';

/**
 * Per-node hard budget envelope. Caps are enforced pre-LLM-call and on
 * wall-clock; `used` fields are updated as the node runs.
 */
export interface NodeBudget {
  tokens: { cap: number; used: number };
  wallClockMs: { cap: number; startedAt: number };
  fanOut: { cap: number; used: number };
  depth: 0 | 1 | 2;
}

/**
 * Default budget envelope per depth.
 *
 * Token cascade rule (pool sharing — parent's tokens count child's tokens too):
 *   child.tokens.cap = min(LEVEL_DEFAULT[child.depth].tokens, parent.remaining.tokens - RESERVE)
 *
 * Wall-clock: NO cascade. Each node's wall cap is its own LEVEL_DEFAULT.
 * The parent's `elapsed()` excludes time spent awaiting children (see
 * AgentWorker.pausedMs). Matches the user spec: "subagent should have the
 * same timeout as an agent — waiting for the subagent should not count
 * against the parent's timeout."
 */
export const LEVEL_DEFAULT: Record<0 | 1 | 2, { tokens: number; wallMs: number; fanOut: number }> = {
  0: { tokens: 200_000, wallMs: 10 * 60_000, fanOut: 6 },
  1: { tokens: 80_000, wallMs: 4 * 60_000, fanOut: 4 },
  // Subagent: same wall cap as Agent per user spec.
  2: { tokens: 30_000, wallMs: 4 * 60_000, fanOut: 0 },
};

/** Fraction of the parent's cap reserved for parent synthesis after child returns. */
export const BUDGET_RESERVE_FRACTION = 0.1;

/**
 * Outbound brief handed from a parent to its child when spawning.
 * Becomes the child's user message.
 */
export interface TaskBrief {
  /** Verbatim one-line echo of the user's original request. */
  originalUserRequest: string;
  /** Slash-separated topic path, e.g. "security/oauth/pkce". */
  topicPath: string;
  /** Compact summary of parent's context, ≤500 tokens. */
  parentSummary: string;
  /** Primary task description, ≤2000 tokens. */
  taskBrief: string;
  /** Hard constraints the child must respect (e.g. "read-only"). */
  constraints: string[];
  /** Input artifacts referenced by ref (file path / URL / data id). */
  inputArtifacts: Array<{
    kind: 'file' | 'url' | 'data';
    ref: string;
    summary?: string;
  }>;
  /** Strict shape the parent wants back. */
  expectedOutput: {
    shape: 'summary' | 'json' | 'markdown' | 'code-diff' | 'list';
    schema?: Record<string, unknown>;
    maxTokens: number;
  };
  /** Explicit prohibitions (auto-set for Subagent: "Do not spawn children"). */
  forbidden: string[];
}

/**
 * Result returned by a child swarm node to its parent.
 * Stored in `swarm_nodes.result` (jsonb).
 */
export interface ChildResult {
  nodeId: string;
  kind: 'agent' | 'subagent';
  status: ChildResultStatus;
  output: unknown;
  usedTokens: number;
  durationMs: number;
  spawnedChildren: string[];
  notes?: string;
}

/**
 * In-memory representation of a node as seen by the spawner. The parent
 * node is passed to `SwarmSpawner.spawnChild` so the spawner can derive
 * tool intersection, remaining budget, and the AbortSignal chain.
 */
export interface AgentNode {
  id: string;                              // = agents.id (1:1)
  rootSessionId: string;
  parentNodeId: string | null;
  kind: SwarmNodeKind;
  depth: 0 | 1 | 2;
  role: AgentRole;
  expertId?: string;
  topicPath: string;
  subtopic?: string;
  model: string;
  budget: NodeBudget;
  /** Superset of tools the node is allowed to use. Children intersect with this. */
  allowedToolIds: Set<string>;
  /** Abort controller rooted at this node. Parent abort → child abort. */
  signal: AbortSignal;
}

/** Params accepted by `spawn_child` tool (after validation). */
export interface SpawnChildParams {
  expertId?: string;
  role?: AgentRole;
  topic: string;
  subtopic: string;
  taskBrief: string;
  expectedOutput: {
    shape: 'summary' | 'json' | 'markdown' | 'code-diff' | 'list';
    schema?: Record<string, unknown>;
    maxTokens?: number;
  };
  /** Same `parallelGroup` in the same turn → parent awaits via `Promise.all`. */
  parallelGroup?: string;
  /** Optional hard constraints forwarded into the child's brief. */
  constraints?: string[];
}
