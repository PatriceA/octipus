import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export interface PipelineStepConfig {
  name: string;
  description?: string;
  topic: string;
  toolIds: string[];
  requiresApproval: boolean;
  promptTemplate?: string;
  stageType?: 'standard' | 'qa_validation';
  maxRetries?: number;
  retryTargetStage?: number;
}

export const pipelineTemplates = pgTable('pipeline_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  description: text('description'),
  isPreset: boolean('is_preset').default(false).notNull(),
  steps: jsonb('steps').$type<PipelineStepConfig[]>().default([]).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type PipelineTemplate = typeof pipelineTemplates.$inferSelect;
export type NewPipelineTemplate = typeof pipelineTemplates.$inferInsert;
