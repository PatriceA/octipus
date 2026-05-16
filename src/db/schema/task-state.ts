import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Memory-redesign Phase B — typed workflow state, replacing the
 * RAG-as-message-board pattern where sibling agents discovered each
 * other's results via cosine similarity over `embeddings` rows tagged
 * `source_type='agent_output'`.
 *
 * See `.octipus/memory-redesign.md` Phase B and
 * `.octipus/memory-redesign-schema.sql`.
 *
 * A `task_state` row is the durable record of one unit of agent work
 * scoped to a session — a single agent run, a pipeline stage, a
 * sub-task. The fan-out story is `pg_notify` on the channel
 * `task_state_<session_id>` (trigger in the migration), so a waiting
 * sibling wakes the instant a peer flips status to `done` instead of
 * polling RAG. Listening connections land in a follow-up — for now
 * readers query directly.
 *
 * Not the same thing as `swarm_nodes`:
 *   - `swarm_nodes` is the live agent-delegation tree (parent/child
 *     budget cascade, status). One row per spawned agent.
 *   - `task_state` is the cross-session typed payload board. Outputs
 *     stay here long enough for siblings or follow-up sessions to
 *     consult them; cleanup ages them out per `retention_policies`
 *     (added in a later phase).
 *
 * `inputs`/`outputs` are intentionally `jsonb` rather than per-shape
 * columns: the shape varies by `task_kind` and we don't want a schema
 * change every time an agent role learns a new field.
 */

export const taskState = pgTable('task_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Session that owns the task — cascade delete with the session. */
  sessionId: uuid('session_id').notNull(),
  /**
   * Swarm node that produced the task (when the task originated from a
   * spawned agent). NULL for tasks created by non-swarm code paths
   * (manual CLI runs, scheduled hooks). ON DELETE SET NULL so a deleted
   * node doesn't erase the typed output. Type is `text` because
   * `swarm_nodes.id` is text (1:1 with `agents.id`).
   */
  swarmNodeId: text('swarm_node_id'),
  userId: uuid('user_id').notNull(),
  /** Optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  /** Role id of the agent that owns the task (e.g. 'coding', 'research'). */
  ownerAgent: text('owner_agent').notNull(),
  /**
   * What this task represents — `assignment` (parent told child to do
   * X), `review` (QA on a peer's output), `finding` (an observation
   * worth surfacing), etc. Free-form text so new kinds can land without
   * a schema migration; the orchestrator and cleanup policy are the
   * only callers that care about the value.
   */
  taskKind: text('task_kind').notNull(),
  /** pending | in_progress | done | cancelled | failed */
  status: text('status').notNull(),
  inputs: jsonb('inputs').notNull().default({}),
  outputs: jsonb('outputs').notNull().default({}),
  /** Task ids this task waits on. Empty array = no dependencies. */
  dependsOn: uuid('depends_on').array().notNull().default([]),
  /** Human-readable failure cause when status='failed'. */
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sessionIdx: index('task_state_session_idx').on(table.sessionId, table.createdAt),
  ownerStatusIdx: index('task_state_owner_status_idx').on(table.ownerAgent, table.status),
  swarmNodeIdx: index('task_state_swarm_node_idx').on(table.swarmNodeId),
}));

export type TaskState = typeof taskState.$inferSelect;
export type NewTaskState = typeof taskState.$inferInsert;

export type TaskStateStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'cancelled'
  | 'failed';
