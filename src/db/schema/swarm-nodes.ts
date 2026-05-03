import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Swarm node schema — sibling table to `agents` representing a node in the
 * agent delegation tree (Orchestrator → Agent → Subagent). See
 * `.octipus/swarm-design.md` §Observability for the authoritative design.
 *
 * The `id` equals the corresponding `agents.id` (1:1 relationship). `agents`
 * remains the historical record; `swarm_nodes` drives the live tree view,
 * budget cascade bookkeeping, cycle detection, and result-caching.
 */

export const swarmNodeKindEnum = pgEnum('swarm_node_kind', [
  'orchestrator',
  'agent',
  'subagent',
]);

export const swarmNodeStatusEnum = pgEnum('swarm_node_status', [
  'running',
  'completed',
  'budget',
  'timeout',
  'denied',
  'tool_error',
  'provider_error',
  'cancelled',
  'concurrency_limit',
  'cache_hit',
]);

/**
 * Structured result returned by a child swarm node to its parent.
 * Mirrors `ChildResult` in `src/core/swarm/types.ts`.
 */
export interface SwarmChildResult {
  nodeId: string;
  kind: 'agent' | 'subagent';
  status:
    | 'ok'
    | 'budget'
    | 'timeout'
    | 'tool_error'
    | 'provider_error'
    | 'cancelled'
    | 'denied'
    | 'concurrency_limit'
    | 'cache_hit';
  output: unknown;
  usedTokens: number;
  durationMs: number;
  spawnedChildren: string[];
  notes?: string;
}

export const swarmNodes = pgTable('swarm_nodes', {
  id: text('id').primaryKey(), // = agents.id (1:1)
  rootSessionId: uuid('root_session_id').notNull(),
  /**
   * Owner of the swarm tree. Same value across every node sharing a root.
   * Nullable in Phase 0 (back-compatible); Phase 1 enforces and uses it
   * for the orphan reaper and per-user concurrency caps.
   */
  userId: text('user_id'),
  /** Phase 4 follow-up — optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  parentNodeId: text('parent_node_id'), // null for Orchestrator
  depth: integer('depth').notNull(),
  kind: swarmNodeKindEnum('kind').notNull(),
  role: text('role').notNull(),
  expertId: uuid('expert_id'),
  topicPath: text('topic_path').notNull(),
  subtopic: text('subtopic'),
  model: text('model').notNull(),
  status: swarmNodeStatusEnum('status').notNull().default('running'),
  tokenCap: integer('token_cap').notNull(),
  tokensUsed: integer('tokens_used').notNull().default(0),
  wallClockCapMs: integer('wall_clock_cap_ms').notNull(),
  fanOutCap: integer('fan_out_cap').notNull(),
  fanOutUsed: integer('fan_out_used').notNull().default(0),
  briefHash: text('brief_hash').notNull(),
  /** First ~4KB of the task brief the parent handed the child. Lets the
   *  live-tree UI show "what was this child asked to do?" without a separate
   *  events lookup. Truncated at insert to keep the row small. */
  taskBriefPreview: text('task_brief_preview'),
  cacheHits: integer('cache_hits').notNull().default(0),
  result: jsonb('result').$type<SwarmChildResult | null>(),
  error: text('error'),
  /**
   * 'await' (default): parent blocks until this child returns.
   * 'detach': parent gets the childId immediately and keeps working; must
   * later call `collect_children` (or the framework auto-collects before
   * the parent emits its final answer). Only valid for subagent nodes
   * (depth 2) spawned by an agent (depth 1).
   */
  spawnMode: text('spawn_mode').notNull().default('await'),
  /** Set by collect_children / auto-collect when the parent picks up this
   *  detached child's result. NULL while pending; non-null after pickup.
   *  Used by orphan-reaper to find detached children whose parent
   *  terminated without collecting. */
  collectedAt: timestamp('collected_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  rootIdx: index('swarm_nodes_root_idx').on(t.rootSessionId),
  parentIdx: index('swarm_nodes_parent_idx').on(t.parentNodeId),
  statusIdx: index('swarm_nodes_status_idx').on(t.status),
  briefHashIdx: index('swarm_nodes_brief_hash_idx').on(t.briefHash),
  userIdx: index('swarm_nodes_user_id_idx').on(t.userId),
}));

export type SwarmNodeRecord = typeof swarmNodes.$inferSelect;
export type NewSwarmNodeRecord = typeof swarmNodes.$inferInsert;
