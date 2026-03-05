import { pgTable, text, timestamp, uuid, jsonb, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';

export const experts = pgTable('presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  role: text('role').notNull(),
  systemPrompt: text('system_prompt'),
  modelPreference: text('model_preference'),
  toolIds: jsonb('tool_ids').$type<string[]>().default([]),
  skillIds: jsonb('skill_ids').$type<string[]>().default([]),
  parameters: jsonb('parameters').$type<ExpertParameters>().default({}),
  isSystem: boolean('is_system').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export interface ExpertParameters {
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  timeout?: number;
}

export type Expert = typeof experts.$inferSelect;
export type NewExpert = typeof experts.$inferInsert;
