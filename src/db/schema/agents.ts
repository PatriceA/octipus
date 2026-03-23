import { pgTable, text, timestamp, uuid, jsonb, integer, pgEnum, index } from 'drizzle-orm/pg-core';

export const agentStatusEnum = pgEnum('agent_status', [
  'running',
  'completed',
  'failed',
  'stopped',
]);

export const agents = pgTable('agents', {
  id: text('id').primaryKey(), // same ID as in-memory agent
  sessionId: uuid('session_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull().default('general'),
  model: text('model').notNull().default(''),
  topic: text('topic').notNull().default(''),
  status: agentStatusEnum('status').notNull().default('running'),
  iterations: integer('iterations').default(0),
  totalTokens: integer('total_tokens').default(0),
  durationMs: integer('duration_ms'),
  error: text('error'),
  toolCalls: jsonb('tool_calls').$type<Array<{ name: string; count: number }>>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  sessionIdx: index('agents_session_id_idx').on(table.sessionId),
  userIdx: index('agents_user_id_idx').on(table.userId),
  statusIdx: index('agents_status_idx').on(table.status),
  createdAtIdx: index('agents_created_at_idx').on(table.createdAt),
}));

export type AgentRecord = typeof agents.$inferSelect;
export type NewAgentRecord = typeof agents.$inferInsert;
