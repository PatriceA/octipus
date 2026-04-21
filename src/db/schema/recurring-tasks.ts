import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const recurringTasks = pgTable('recurring_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  cronExpression: text('cron_expression').notNull(),
  timezone: text('timezone').default('UTC'),
  actionType: text('action_type').notNull(), // spawn_agent, execute_tool, webhook
  actionConfig: jsonb('action_config').$type<RecurringTaskConfig>().notNull(),
  isEnabled: boolean('is_enabled').default(true).notNull(),
  lastRunAt: timestamp('last_run_at'),
  nextRunAt: timestamp('next_run_at'),
  runCount: integer('run_count').default(0).notNull(),
  lastError: text('last_error'),
  status: text('status').default('active').notNull(), // active, paused, error, stopped
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('recurring_tasks_user_id_idx').on(table.userId),
  nextRunIdx: index('recurring_tasks_next_run_idx').on(table.nextRunAt),
}));

export interface RecurringTaskConfig {
  // For spawn_agent
  agentTopic?: string;
  agentPrompt?: string;
  agentRole?: string;
  // For execute_tool
  toolId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  // For webhook
  webhookUrl?: string;
  webhookMethod?: string;
  webhookHeaders?: Record<string, string>;
  webhookBody?: unknown;
}

export type RecurringTask = typeof recurringTasks.$inferSelect;
export type NewRecurringTask = typeof recurringTasks.$inferInsert;
