import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: text('role').notNull().unique(),
  toolIds: jsonb('tool_ids').$type<string[]>().default([]).notNull(),
  /**
   * True once a user has edited this role's toolIds via the UI. When set, the
   * boot-time seed stops auto-merging new code-level tool ids into the row, so
   * a user's removals (and additions) survive restarts. When false, the row
   * tracks the code config (code is the default/fallback).
   */
  toolIdsCustomized: boolean('tool_ids_customized').default(false).notNull(),
  defaultTopic: text('default_topic').notNull().default('general'),
  systemPromptTemplate: text('system_prompt_template').notNull(),
  isSystem: boolean('is_system').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
