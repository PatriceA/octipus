import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export type AgentApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * Questions an agent put to its user (`request_approval`, pipeline gates).
 * The promise the agent awaits lives in process memory; this row is the
 * durable record, so an answer arriving after a restart finds the request
 * expired rather than "not found".
 */
export const agentApprovals = pgTable('agent_approvals', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id'),
  agentId: text('agent_id').notNull(),
  /** Random id of the process that asked: tells a timed-out request from one lost to a restart. */
  bootId: text('boot_id').notNull(),
  summary: text('summary').notNull(),
  question: text('question').notNull(),
  options: jsonb('options').$type<string[]>(),
  status: text('status').$type<AgentApprovalStatus>().notNull().default('pending'),
  response: text('response'),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('agent_approvals_user_status_idx').on(t.userId, t.status),
  index('agent_approvals_pending_idx').on(t.status).where(sql`status = 'pending'`),
]);
export type AgentApproval = typeof agentApprovals.$inferSelect;
