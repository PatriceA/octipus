import { pgTable, text, timestamp, serial, jsonb, index } from 'drizzle-orm/pg-core';

export const agentEvents = pgTable('agent_events', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id').notNull(),
  type: text('type').notNull(), // thought, action, observation, error, complete, status_change, permission_request
  data: jsonb('data').$type<unknown>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  agentIdIdx: index('agent_events_agent_id_idx').on(table.agentId),
  sessionIdIdx: index('agent_events_session_id_idx').on(table.sessionId),
  createdAtIdx: index('agent_events_created_at_idx').on(table.createdAt),
}));

export type AgentEventRecord = typeof agentEvents.$inferSelect;
export type NewAgentEventRecord = typeof agentEvents.$inferInsert;
