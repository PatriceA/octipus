import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tasks } from './tasks';
import { users } from './users';

/**
 * A comment thread per task (work board). Agents leave progress notes and
 * hand-offs here; the user answers. `userId` is the task owner, so the scoped
 * repo filters comments the same way it filters tasks. `authorKind` is
 * 'user' | 'agent'; `authorRef` is the user id or the agent / node id.
 */
export const taskComments = pgTable('task_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  authorKind: text('author_kind').$type<'user' | 'agent'>().notNull(),
  authorRef: text('author_ref').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  taskCreatedIdx: index('task_comments_task_idx').on(table.taskId, table.createdAt),
}));

export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
