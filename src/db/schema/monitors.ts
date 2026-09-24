import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';
import { sessions } from './sessions';
import type { MonitorSource, MonitorStatus, Observation } from '@/core/monitors/types';

export const monitors = pgTable('monitors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  generation: text('generation'),
  role: text('role').notNull(),
  name: text('name').notNull(),
  continuation: text('continuation').notNull(),
  source: jsonb('source').$type<MonitorSource>().notNull(),
  status: text('status').$type<MonitorStatus>().notNull().default('armed'),
  intervalSeconds: integer('interval_seconds').notNull(),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  previous: jsonb('previous').$type<{ value: unknown }>(),
  observation: jsonb('observation').$type<Observation>(),
  lastError: text('last_error'),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('monitors_due_idx').on(t.status, t.nextCheckAt), index('monitors_session_idx').on(t.sessionId, t.userId)]);
export type Monitor = typeof monitors.$inferSelect;
