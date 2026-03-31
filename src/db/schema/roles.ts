import { pgTable, text, timestamp, uuid, jsonb, boolean } from 'drizzle-orm/pg-core';

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: text('role').notNull().unique(),
  toolIds: jsonb('tool_ids').$type<string[]>().default([]).notNull(),
  defaultTopic: text('default_topic').notNull().default('general'),
  systemPromptTemplate: text('system_prompt_template').notNull(),
  isSystem: boolean('is_system').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
