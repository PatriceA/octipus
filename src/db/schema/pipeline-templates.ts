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
  /**
   * Per-stage model override (a bound model name/id, never a literal in source).
   * When set, this stage's worker runs on this model instead of the topic's
   * primary binding. Empty ⇒ topic binding (today's behaviour).
   */
  model?: string;
}

/**
 * A typed, user-supplied parameter for a recipe (parameterized pipeline
 * template). Values are substituted into stage prompt templates as
 * `{{param.<key>}}`.
 */
export interface RecipeParameter {
  key: string;
  description?: string;
  inputType: 'string' | 'number' | 'boolean' | 'date' | 'select';
  requirement: 'required' | 'optional' | 'user_prompt';
  default?: string;
  /** Allowed values when inputType === 'select'. */
  options?: string[];
}

export const pipelineTemplates = pgTable('pipeline_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  description: text('description'),
  isPreset: boolean('is_preset').default(false).notNull(),
  steps: jsonb('steps').$type<PipelineStepConfig[]>().default([]).notNull(),
  /** Typed parameters the recipe accepts; substituted as `{{param.<key>}}`. */
  parameters: jsonb('parameters').$type<RecipeParameter[]>().default([]).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PipelineTemplate = typeof pipelineTemplates.$inferSelect;
export type NewPipelineTemplate = typeof pipelineTemplates.$inferInsert;
