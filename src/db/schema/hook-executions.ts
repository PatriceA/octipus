import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { hooks } from './hooks';
import { recurringTasks } from './recurring-tasks';

export const executionStatusEnum = pgEnum('execution_status', [
  'success',
  'error',
  'skipped',
]);

export const executionSourceEnum = pgEnum('execution_source', [
  'hook',
  'recurring_task',
  'manual_test',
]);

export const hookExecutions = pgTable('hook_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  hookId: uuid('hook_id').references(() => hooks.id, { onDelete: 'cascade' }),
  recurringTaskId: uuid('recurring_task_id').references(() => recurringTasks.id, { onDelete: 'cascade' }),
  /**
   * Denormalized owner of the originating hook / recurring task. Lets the
   * hook-execution feed be filtered per user without a join. Nullable in
   * Phase 0; Phase 1 backfills from the parent hook/task.
   */
  userId: uuid('user_id'),
  source: executionSourceEnum('source').notNull(),
  status: executionStatusEnum('status').notNull(),
  triggerType: text('trigger_type'),
  actionType: text('action_type'),
  // Result data from the action execution
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  durationMs: integer('duration_ms'),
  // Context snapshot — what triggered the execution
  triggerContext: jsonb('trigger_context').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  hookIdIdx: index('hook_executions_hook_id_idx').on(table.hookId),
  recurringTaskIdIdx: index('hook_executions_recurring_task_id_idx').on(table.recurringTaskId),
  createdAtIdx: index('hook_executions_created_at_idx').on(table.createdAt),
  statusIdx: index('hook_executions_status_idx').on(table.status),
  userIdIdx: index('hook_executions_user_id_idx').on(table.userId),
}));

export type HookExecution = typeof hookExecutions.$inferSelect;
export type NewHookExecution = typeof hookExecutions.$inferInsert;
