import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Minimal recovery evidence. No tool arguments, secrets or result bodies. */
export const toolActions = pgTable('tool_actions', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  agentId: text('agent_id').notNull(),
  pipelineId: text('pipeline_id'),
  nodeKey: text('node_key'),
  toolId: text('tool_id').notNull(),
  toolName: text('tool_name').notNull(),
  argumentHash: text('argument_hash').notNull(),
  status: text('status').$type<'started' | 'completed' | 'uncertain' | 'not_executed'>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewId: text('review_id'),
}, t => [index('tool_actions_recovery_idx').on(t.userId, t.sessionId, t.reviewedAt),
  index('tool_actions_pipeline_idx').on(t.userId, t.pipelineId)]);
export type ToolAction = typeof toolActions.$inferSelect;
