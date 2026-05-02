import { index, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const agentEvents = pgTable('agent_events', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  /**
   * Denormalized owner — copied from agents.user_id at write time so the
   * audit / activity feed can be filtered without a join. Nullable in
   * Phase 0; Phase 1 backfills from agents and switches every reader to
   * filter on it.
   */
  userId: text('user_id'),
  type: text('type').notNull(), // thought, action, observation, error, complete, status_change, permission_request
  data: jsonb('data').$type<unknown>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  agentIdIdx: index('agent_events_agent_id_idx').on(table.agentId),
  sessionIdIdx: index('agent_events_session_id_idx').on(table.sessionId),
  userIdIdx: index('agent_events_user_id_idx').on(table.userId),
  createdAtIdx: index('agent_events_created_at_idx').on(table.createdAt),
}));

export type AgentEventRecord = typeof agentEvents.$inferSelect;
export type NewAgentEventRecord = typeof agentEvents.$inferInsert;
