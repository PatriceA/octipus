import { sql } from 'drizzle-orm';
import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { TaskRepeat } from '@/core/tasks/repeat';
import { users } from './users';
import { workspaces } from './organizations';

/**
 * Personal tasks / todos (feature #6). Distinct from `recurring_tasks` (cron
 * automation) and `task_state` (agent-internal sibling discovery) — this is a
 * user-facing todo list the agent can read, create, and complete.
 *
 * `source`/`sourceRef` are the differentiator: a task records where it came
 * from (a chat turn, a plugin's action-item, an email triage) so the UI can link
 * back to the origin.
 */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /**
   * Phase 4 — optional workspace scope. NULL = user-level (visible to every
   * workspace the user owns). FK in the migration uses ON DELETE SET NULL.
   */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
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
  /**
   * Work board (after Paperclip). `assigneeKind` is 'user' | 'role' | 'node'
   * (see core/tasks/status.ts) and `assigneeRef` names it: a user id, a role
   * id, a swarm node id. The checkout fields say who is working the task right
   * now; they are written only by ScopedTaskRepo.checkout / release (a single
   * conditional UPDATE, so a second claimer loses) and cleared when the task
   * is done or archived.
   */
  assigneeKind: text('assignee_kind'),
  assigneeRef: text('assignee_ref'),
  checkedOutBy: text('checked_out_by'),
  checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
  checkoutRunId: text('checkout_run_id'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  /**
   * Follow-up ("Wiedervorlage", docs/CASES.md): when the task comes back to
   * its assignee's attention. The cron loop stamps `remindedAt` once it
   * passes and notifies if the task is still active (core/tasks/reminders.ts);
   * changing `remindAt` clears the stamp, so the reminder fires again.
   */
  remindAt: timestamp('remind_at', { withTimezone: true }),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /**
   * The personal layer (to-do redesign, migration 0205). `important` is the
   * star. `sortOrder` is the manual order within a list, ascending; a new row
   * gets minus its creation time in ms, so the newest comes first until the
   * user drags, and a drag writes a value between its neighbours. `myDayOn`
   * is the calendar day (in the user's zone) the to-do was put in My Day; it
   * is in My Day only while that day is today, so the list empties itself at
   * midnight without a job. `repeat` is the rule of core/tasks/repeat.ts;
   * completing a repeating to-do creates the next occurrence and records it
   * in `repeatNextId`, which is what makes that happen once (TaskRepo.update).
   */
  important: boolean('important').default(false).notNull(),
  sortOrder: doublePrecision('sort_order').default(sql`(-(extract(epoch from now()) * 1000))`).notNull(),
  myDayOn: date('my_day_on', { mode: 'string' }),
  repeat: jsonb('repeat').$type<TaskRepeat>(),
  repeatNextId: uuid('repeat_next_id'),
  /** Provenance: 'user' | 'agent' | 'reader' | 'research' | 'email' | 'channel'. 'reader' and 'research' are kept for existing tasks (the core reader and research module are removed; their example plugins write 'agent' or no task). */
  source: text('source').default('user').notNull(),
  /** Optional link back to the origin (sessionId, url, messageId, …). */
  sourceRef: jsonb('source_ref').$type<TaskSourceRef>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userStatusDueIdx: index('tasks_user_status_due_idx').on(table.userId, table.status, table.dueAt),
  parentIdx: index('tasks_parent_idx').on(table.parentId),
  userAssigneeIdx: index('tasks_user_assignee_idx').on(table.userId, table.assigneeKind, table.assigneeRef, table.status),
  dueReminderIdx: index('tasks_due_reminder_idx').on(table.remindAt).where(sql`${table.remindAt} IS NOT NULL AND ${table.remindedAt} IS NULL`),
}));

export interface TaskSourceRef {
  /** Snapshot retained when source sessions are deleted; inherited by task readers and heartbeats. */
  protectionLevel?: number;
  flowLabel?: Partial<Record<'private'|'secret'|'suspicious',string>>;
  sessionId?: string;
  messageId?: string;
  url?: string;
  /** Documents row the task was made from (e.g. a report of the removed core research module). */
  documentId?: string;
  /** Free-form label, e.g. "Acme thread" or the email subject. */
  label?: string;
}

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
