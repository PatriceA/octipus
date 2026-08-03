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
  /**
   * DECLARES that this stage is expected to leave files behind. Only declared
   * stages are evidence-gated: a run that changed zero files fails instead of
   * reporting green over an empty workspace (docs/plans/pipeline-evidence-gate.md).
   *
   * Deliberately opt-in, never inferred from the stage name or its prompt
   * wording — a research/review stage legitimately writes nothing, and wrongly
   * failing work that actually succeeded is worse than no gate at all.
   */
  producesArtifacts?: boolean;
  /**
   * DECLARES that this stage's whole purpose is to EXECUTE something — run the
   * test suite, the linter, the build — not merely to read and reason about it.
   * A declared stage that finishes having run zero commands fails.
   *
   * The failure this closes, measured on 2026-08-03: a Testing agent whose tool
   * set had been intersected down to `filesystem` announced "I cannot run shell
   * commands… I'll simulate execution by analyzing the test logic", then emitted
   * a full per-test PASS table and "18 passed, 0 failed". Its receipt was
   * honest (`commandsRun: 0`) and nothing compared that honest receipt against
   * what the stage was for, so a simulation was accepted as a test run. The
   * claim happened to be true, which is luck, not verification.
   *
   * Opt-in for the same reason as `producesArtifacts`: it is a declaration of
   * purpose, never inferred from a stage's name or prompt wording.
   */
  runsCommands?: boolean;
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
