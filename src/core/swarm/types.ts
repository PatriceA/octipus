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

export interface LevelDefault {
  tokens: number;
  wallMs: number;
  fanOut: number;
  maxPendingDetached: number;
}

/**
 * Hard-coded fallback envelope per depth. The live values are read from
 * `config.swarm.levelDefaults` via `getLevelDefault(depth)` — this record
 * is only used if config is not loaded (startup edge-cases and unit tests
 * that don't boot the full config pipeline).
 *
 * Token cascade rule (pool sharing):
 *   child.tokens.cap = min(LEVEL_DEFAULT[child.depth].tokens, parent.remaining.tokens - RESERVE)
 *
 * Wall-clock: NO cascade. Parent's `elapsed()` excludes child-wait time
 * (AgentWorker.pausedMs). Subagent shares the Agent wall so `await` on a
 * subagent doesn't starve an agent that still has real work to do.
 */
export const LEVEL_DEFAULT: Record<0 | 1 | 2, LevelDefault> = {
  0: { tokens: 200_000, wallMs: 10 * 60_000, fanOut: 6, maxPendingDetached: 0 },
  1: { tokens: 80_000, wallMs: 4 * 60_000, fanOut: 4, maxPendingDetached: 3 },
  2: { tokens: 30_000, wallMs: 4 * 60_000, fanOut: 0, maxPendingDetached: 0 },
};

/**
 * Read the live per-depth default from config. Falls back to the hardcoded
 * LEVEL_DEFAULT record when config hasn't been loaded yet (e.g. in
 * isolated unit tests).
 */
export function getLevelDefault(depth: 0 | 1 | 2): LevelDefault {
  try {
    // Lazy require so this file stays importable without a config pipeline.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('@/config');
    const cfg = getConfig().swarm?.levelDefaults;
    const key = depth === 0 ? 'orchestrator' : depth === 1 ? 'agent' : 'subagent';
    const entry = cfg?.[key];
    if (entry) {
      return {
        tokens: entry.tokens,
        wallMs: entry.wallMs,
        fanOut: entry.fanOut,
        maxPendingDetached: entry.maxPendingDetached ?? LEVEL_DEFAULT[depth].maxPendingDetached,
      };
    }
  } catch {
    // Config not loaded or require failed → fall through to hardcoded.
  }
  return LEVEL_DEFAULT[depth];
}

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
  /**
   * 'await' (default): parent blocks until child returns, result surfaced
   * inline, parent pausedMs ticks while waiting.
   * 'detach': parent gets { childId, status: 'pending' } immediately and
   * keeps working. Must later call `collect_children` (or framework
   * auto-collects at finalize). Only valid at depth 1 (agent → subagent).
   */
  mode?: 'await' | 'detach';
}

/**
 * Record of a detached child tracked on the parent's worker so the
 * framework can enforce the max-pending cap, surface nudges, auto-collect
 * at finalize, and cancel on parent failure.
 */
export interface PendingChild {
  childId: string;
  startedAt: number;
  taskBrief: string;
  topic: string;
  subtopic?: string;
  promise: Promise<ChildResult>;
}
