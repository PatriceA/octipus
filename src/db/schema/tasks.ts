import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Personal tasks / todos (feature #6). Distinct from `recurring_tasks` (cron
 * automation) and `task_state` (agent-internal sibling discovery) — this is a
 * user-facing todo list the agent can read, create, and complete.
 *
 * `source`/`sourceRef` are the differentiator: a task records where it came
 * from (a chat turn, a reader action-item, an email triage) so the UI can link
 * back to the origin.
 */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /**
   * Phase 4 — optional workspace scope. NULL = user-level (visible to every
   * workspace the user owns). FK in the migration uses ON DELETE SET NULL.
   */
  workspaceId: uuid('workspace_id'),
  title: text('title').notNull(),
  notes: text('notes'),
  /** 'open' | 'in_progress' | 'done' | 'archived' — see core/tasks/status.ts. */
  status: text('status').default('open').notNull(),
  priority: integer('priority').default(0).notNull(), // 0 none .. 3 high
  /**
   * Free-form user category / list ("Shopping", "House work", "Car"). NULL =
   * uncategorized. Not an enum — categories are user-defined; the UI offers
   * existing ones for reuse but never constrains the set.
   */
  category: text('category'),
  /**
   * Structure (daily-driver plan, Phase 2). A task can sit under a parent
   * (a phase, an epic, a bigger task) and wait on other tasks. `parentId` is
   * a self-FK with ON DELETE SET NULL in the migration (deleting a phase
   * frees its children rather than taking them along); `blockedBy` holds
   * task ids and only OPEN blockers block — a done, archived or deleted id
   * in the array is inert, so the array is never rewritten on the blocker's
   * behalf. `estimate` is free text in whatever unit the user works in
   * ("S", "M", "3h"); the pm role speaks T-shirt sizes.
   */
  parentId: uuid('parent_id'),
  blockedBy: uuid('blocked_by').array().default([]).notNull(),
  estimate: text('estimate'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** Provenance: 'user' | 'agent' | 'reader' | 'research' | 'email'. */
  source: text('source').default('user').notNull(),
  /** Optional link back to the origin (sessionId, url, messageId, …). */
  sourceRef: jsonb('source_ref').$type<TaskSourceRef>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userStatusDueIdx: index('tasks_user_status_due_idx').on(table.userId, table.status, table.dueAt),
  parentIdx: index('tasks_parent_idx').on(table.parentId),
}));

export interface TaskSourceRef {
  sessionId?: string;
  messageId?: string;
  url?: string;
  /** Documents row the task was made from (e.g. a Deep Research report). */
  documentId?: string;
  /** Free-form label, e.g. "Acme thread" or the email subject. */
  label?: string;
}

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
