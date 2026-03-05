import { pgTable, text, timestamp, uuid, jsonb, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';

export const presets = pgTable('presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  role: text('role').notNull(),
  systemPrompt: text('system_prompt'),
  modelPreference: text('model_preference'),
  skillIds: jsonb('skill_ids').$type<string[]>().default([]),
  parameters: jsonb('parameters').$type<PresetParameters>().default({}),
  isSystem: boolean('is_system').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export interface PresetParameters {
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  timeout?: number;
}

export type Preset = typeof presets.$inferSelect;
export type NewPreset = typeof presets.$inferInsert;
