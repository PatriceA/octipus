import { index, jsonb, pgTable, serial, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  /** Phase 4 follow-up — optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  /**
   * WS4 run correlation — the `run_<uuid>` id of the orchestrated turn that
   * produced this event, stamped from the ambient run context at write time.
   * NULL for events emitted outside any orchestrated turn (e.g. legacy rows or
   * out-of-band jobs). Indexed so an operator can pull an entire turn's event
   * trail — across every child agent it spawned — with one query.
   */
  runId: text('run_id'),
  type: text('type').notNull(), // thought, action, observation, error, complete, status_change, permission_request
  data: jsonb('data').$type<unknown>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  agentIdIdx: index('agent_events_agent_id_idx').on(table.agentId),
  sessionIdIdx: index('agent_events_session_id_idx').on(table.sessionId),
  userIdIdx: index('agent_events_user_id_idx').on(table.userId),
  createdAtIdx: index('agent_events_created_at_idx').on(table.createdAt),
  runIdIdx: index('agent_events_run_id_idx').on(table.runId),
}));

export type AgentEventRecord = typeof agentEvents.$inferSelect;
export type NewAgentEventRecord = typeof agentEvents.$inferInsert;
