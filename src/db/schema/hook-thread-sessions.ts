import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { hooks } from './hooks';

/**
 * The session a `spawn_agent` hook keeps for one thread of work: a pull
 * request, an issue, a ticket — whatever its `actionConfig.threadKey` template
 * renders from the event (src/hooks/thread-sessions.ts). The first event on a
 * thread mints the session; later events on the same thread run in it, so the
 * agent that reviewed PR #42 is the one that reads the follow-up comment.
 *
 * `session_id` carries no foreign key: the session row is created by the
 * first turn, after this row exists. A session deleted since is simply
 * recreated under the same id by the next turn, as a hook's own session is.
 * Rows go with their hook (ON DELETE CASCADE), when the thread ends
 * (`threadEndActions`), and after THREAD_IDLE_DAYS without an event.
 */
export const hookThreadSessions = pgTable('hook_thread_sessions', {
  hookId: uuid('hook_id').references(() => hooks.id, { onDelete: 'cascade' }).notNull(),
  threadKey: text('thread_key').notNull(),
  sessionId: uuid('session_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.hookId, table.threadKey] }),
  lastUsedIdx: index('hook_thread_sessions_last_used_idx').on(table.lastUsedAt),
}));

export type HookThreadSession = typeof hookThreadSessions.$inferSelect;
