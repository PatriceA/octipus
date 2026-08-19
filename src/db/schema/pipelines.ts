import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import { users } from './users';

export const pipelineStatusEnum = pgEnum('pipeline_status', [
  'planning', 'running', 'paused', 'awaiting_approval', 'completed', 'failed',
]);

export const stageStatusEnum = pgEnum('stage_status', [
  'pending', 'running', 'awaiting_approval', 'approved', 'completed', 'failed', 'skipped',
]);

/**
 * What a node IS, as opposed to what it does.
 *
 * - `step` — runs one worker once per visit. The old pipeline stage.
 * - `foreach` — runs its body once per PENDING plan item. Executes no worker
 *   itself; it is the loop head, and it re-reads `plan_items` on every visit so
 *   items appended mid-run by a review or QA node are picked up (see
 *   `plan_items` below).
 * - `human` — runs no worker either: the walk stops and asks a person, and
 *   their answer becomes the node's output and the next node's input. A
 *   first-class node rather than a flag on a step, so a graph can ask a
 *   question anywhere without a stage having to pretend to be an agent.
 */
export const pipelineNodeKindEnum = pgEnum('pipeline_node_kind', ['step', 'foreach', 'human']);

/**
 * How the walker chooses an outgoing edge. Conditions are matched against the
 * outcome the source node produced; the first matching edge in `ordinal` order
 * wins, so a specific condition must be ordered before `always`.
 *
 * - `always` — unconditional successor.
 * - `qa_pass` / `qa_fail` — a `qa_validation` node's verdict. `qa_fail` is the
 *   backward edge that used to be the hardcoded retry loop.
 * - `audit_gate_failed` — the verdict was rejected as unaccountable rather than
 *   the work being wrong, so the AUDITOR re-runs alone (normally a self-edge).
 *   Re-running the implementation here would burn a paid run on work that was
 *   fine and can trip its own evidence gate.
 * - `loop_body` / `loop_done` — a `foreach` node's two exits.
 * - `on_error` — the source node failed. Absent ⇒ a failure fails the pipeline,
 *   which is today's behaviour.
 */
export const pipelineEdgeConditionEnum = pgEnum('pipeline_edge_condition', [
  'always', 'qa_pass', 'qa_fail', 'audit_gate_failed', 'loop_body', 'loop_done', 'on_error',
]);

/** Lifecycle of one item on a pipeline's plan. */
export const planItemStatusEnum = pgEnum('plan_item_status', [
  'pending', 'running', 'done', 'failed', 'skipped',
]);

export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orchestratorAgentId: text('orchestrator_agent_id').notNull(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  /** Phase 4 follow-up — optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  title: text('title').notNull(),
  type: text('type').notNull(), // 'development' | 'research' | 'general'
  description: text('description'),
  status: pipelineStatusEnum('status').default('planning').notNull(),
  /**
   * The node the walker is on, by `nodeKey`. Replaces the old
   * `currentStageIndex`: a graph has no single ordinal position — a backward
   * edge or a loop body revisits nodes, and an index cannot express that.
   */
  currentNodeKey: text('current_node_key'),
  summary: text('summary'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/**
 * One node of a pipeline's execution graph. Formerly `pipeline_stages`, which
 * modelled a strictly linear list walked by `currentStageIndex`.
 *
 * A node row is the node's DEFINITION plus its LATEST run. Loop iterations do
 * not each get a row — per-iteration state lives on `plan_items`, so a five-item
 * loop stays five plan rows and three node rows instead of fifteen node rows.
 */
export const pipelineNodes = pgTable('pipeline_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'cascade' }).notNull(),
  /**
   * Stable identifier within one pipeline, assigned by the template compiler.
   * Edges reference nodes by key rather than by row id so a graph can be
   * compiled, validated, and unit-tested before anything is persisted.
   */
  nodeKey: text('node_key').notNull(),
  kind: pipelineNodeKindEnum('kind').default('step').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(), // AgentRole
  model: text('model'),
  toolIds: jsonb('skill_ids').$type<string[]>().default([]),
  systemPrompt: text('system_prompt').notNull(),
  input: text('input').default('').notNull(),
  output: text('output'),
  workerAgentId: text('worker_agent_id'),
  status: stageStatusEnum('status').default('pending').notNull(),
  requiresApproval: boolean('requires_approval').default(false).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id),
  /** Display order only — execution order comes from the edges. */
  ordinal: integer('ordinal').notNull(),
  /** For a loop-body node: the `nodeKey` of the `foreach` head that owns it. */
  parentNodeKey: text('parent_node_key'),
  /** How many times the walker has entered this node. Bounds are on the edges. */
  visits: integer('visits').default(0).notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/** A directed edge. Execution order lives here, not in a node ordinal. */
export const pipelineEdges = pgTable('pipeline_edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'cascade' }).notNull(),
  fromNodeKey: text('from_node_key').notNull(),
  toNodeKey: text('to_node_key').notNull(),
  condition: pipelineEdgeConditionEnum('condition').default('always').notNull(),
  /**
   * Traversal bound for this edge. A cycle without one is an infinite loop, so
   * every BACKWARD edge the compiler emits carries the retry count it replaces.
   * NULL = unbounded, only valid on a forward edge.
   */
  maxTraversals: integer('max_traversals'),
  /** Traversals so far. Compared against `maxTraversals` by the walker. */
  traversals: integer('traversals').default(0).notNull(),
  /** Match order among edges leaving the same node; lower wins. */
  ordinal: integer('ordinal').default(0).notNull(),
});

/**
 * One item of a pipeline's plan — the unit a `foreach` node iterates.
 *
 * The plan is deliberately a live object, not a snapshot taken at approval
 * time: a review or QA node that discovers new work appends an item and the
 * loop picks it up on its next visit, and the user can edit, reorder, or kill
 * items from the UI at any point. That is the whole reason the loop re-reads
 * this table instead of capturing a list.
 */
export const planItems = pgTable('plan_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'cascade' }).notNull(),
  /** Iteration order. Not unique — reordering rewrites these. */
  ordinal: integer('ordinal').notNull(),
  title: text('title').notNull(),
  detail: text('detail'),
  status: planItemStatusEnum('status').default('pending').notNull(),
  /** `nodeKey` of the node that created this item (the planner, or a finder). */
  createdByNodeKey: text('created_by_node_key'),
  /** Set when a human edited or added the item, so provenance stays honest. */
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  /** Last iteration's handoff/summary for this item. */
  result: text('result'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
export type PipelineNodeRow = typeof pipelineNodes.$inferSelect;
export type NewPipelineNode = typeof pipelineNodes.$inferInsert;
export type PipelineEdgeRow = typeof pipelineEdges.$inferSelect;
export type NewPipelineEdge = typeof pipelineEdges.$inferInsert;
export type PlanItemRow = typeof planItems.$inferSelect;
export type NewPlanItem = typeof planItems.$inferInsert;
