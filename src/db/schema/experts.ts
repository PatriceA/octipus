import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const experts = pgTable('presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  role: text('role').notNull(),
  /**
   * Model lane (canonical topic, see src/models/topics.ts) this expert's
   * workers resolve their model from. `role` stays the tool bundle + base
   * prompt; `topic` decides WHICH model serves the expert. Defaults to the
   * main 'agents' lane; an explicit modelPreference still wins over the lane.
   */
  topic: text('topic').notNull().default('agents'),
  systemPrompt: text('system_prompt'),
  modelPreference: text('model_preference'),
  toolIds: jsonb('tool_ids').$type<string[]>().default([]),
  skillIds: jsonb('skill_ids').$type<string[]>().default([]),
  parameters: jsonb('parameters').$type<ExpertParameters>().default({}),
  criticalRules: jsonb('critical_rules').$type<string[]>().default([]),
  deliverableTemplate: text('deliverable_template'),
  successMetrics: jsonb('success_metrics').$type<string[]>().default([]),
  isSystem: boolean('is_system').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export interface ExpertParameters {
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  timeout?: number;
}

export type Expert = typeof experts.$inferSelect;
export type NewExpert = typeof experts.$inferInsert;
