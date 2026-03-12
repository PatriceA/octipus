import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';

export const triggerTypeEnum = pgEnum('trigger_type', [
  'message_received',
  'agent_started',
  'agent_completed',
  'agent_failed',
  'tool_executed',
  'permission_requested',
  'schedule',
  'webhook',
]);

export const actionTypeEnum = pgEnum('action_type', [
  'notify',
  'spawn_agent',
  'webhook',
  'n8n_workflow',
  'execute_tool',
]);

export const hooks = pgTable('hooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  trigger: triggerTypeEnum('trigger').notNull(),
  triggerConfig: jsonb('trigger_config').$type<TriggerConfig>().notNull(),
  action: actionTypeEnum('action').notNull(),
  actionConfig: jsonb('action_config').$type<ActionConfig>().notNull(),
  // Conditions for triggering
  conditions: jsonb('conditions').$type<HookCondition[]>().default([]),
  // Execution control
  isEnabled: boolean('is_enabled').default(true).notNull(),
  priority: integer('priority').default(0).notNull(),
  maxExecutions: integer('max_executions'), // null = unlimited
  executionCount: integer('execution_count').default(0).notNull(),
  cooldownMs: integer('cooldown_ms').default(0), // Minimum time between executions
  lastExecutedAt: timestamp('last_executed_at'),
  // Schedule-specific (for schedule trigger)
  nextRunAt: timestamp('next_run_at'),
  lastError: text('last_error'),
  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('hooks_user_id_idx').on(table.userId),
  triggerIdx: index('hooks_trigger_idx').on(table.trigger),
  isEnabledIdx: index('hooks_is_enabled_idx').on(table.isEnabled),
  nextRunAtIdx: index('hooks_next_run_at_idx').on(table.nextRunAt),
}));

export interface TriggerConfig {
  // For message_received
  channelTypes?: string[];
  messagePatterns?: string[];
  // For schedule
  cronExpression?: string;
  timezone?: string;
  // For webhook
  webhookPath?: string;
  webhookSecret?: string;
  // For tool_executed
  toolIds?: string[];
  toolNames?: string[];
  // Common
  sessionFilter?: {
    topics?: string[];
    userIds?: string[];
  };
}

export interface ActionConfig {
  // For notify
  notifyChannels?: string[];
  notifyMessage?: string;
  // For spawn_agent
  agentTopic?: string;
  agentPrompt?: string;
  agentModel?: string;
  // For webhook
  webhookUrl?: string;
  webhookMethod?: 'GET' | 'POST' | 'PUT';
  webhookHeaders?: Record<string, string>;
  webhookBody?: string;
  // For n8n_workflow
  workflowId?: string;
  workflowData?: Record<string, unknown>;
  // For execute_tool
  toolId?: string;
  toolAction?: string;
  toolParams?: Record<string, unknown>;
  // General options
  orchestrated?: boolean;
  notifyOwner?: boolean;
}

export interface HookCondition {
  field: string; // e.g., "message.content", "agent.status"
  operator: 'equals' | 'contains' | 'matches' | 'gt' | 'lt' | 'in';
  value: unknown;
}

export type Hook = typeof hooks.$inferSelect;
export type NewHook = typeof hooks.$inferInsert;
