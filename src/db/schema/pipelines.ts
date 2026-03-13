import { pgTable, text, timestamp, uuid, jsonb, integer, pgEnum, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';
import { sessions } from './sessions';

export const pipelineStatusEnum = pgEnum('pipeline_status', [
  'planning', 'running', 'paused', 'awaiting_approval', 'completed', 'failed',
]);

export const stageStatusEnum = pgEnum('stage_status', [
  'pending', 'running', 'awaiting_approval', 'approved', 'completed', 'failed', 'skipped',
]);

export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orchestratorAgentId: text('orchestrator_agent_id').notNull(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  type: text('type').notNull(), // 'development' | 'research' | 'general'
  description: text('description'),
  status: pipelineStatusEnum('status').default('planning').notNull(),
  currentStageIndex: integer('current_stage_index').default(0).notNull(),
  summary: text('summary'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export const pipelineStages = pgTable('pipeline_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(), // AgentRole
  model: text('model'),
  toolIds: jsonb('skill_ids').$type<string[]>().default([]),
  systemPrompt: text('system_prompt').notNull(),
  input: text('input').default('').notNull(),
  output: text('output'),
  workerAgentId: text('worker_agent_id'),
  status: stageStatusEnum('status').default('pending').notNull(),
  requiresApproval: boolean('requires_approval').default(false).notNull(),
  approvedAt: timestamp('approved_at'),
  approvedBy: uuid('approved_by').references(() => users.id),
  stageIndex: integer('stage_index').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
export type PipelineStageRow = typeof pipelineStages.$inferSelect;
export type NewPipelineStage = typeof pipelineStages.$inferInsert;
