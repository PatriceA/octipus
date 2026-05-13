import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  valueType: text('value_type').notNull().default('string'), // string|number|boolean|json|string_array
  category: text('category').notNull(),
  description: text('description'),
  defaultValue: text('default_value'),
  isSecret: boolean('is_secret').notNull().default(false),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  categoryIdx: index('settings_category_idx').on(table.category),
}));

export type SettingEntry = typeof settings.$inferSelect;
export type NewSettingEntry = typeof settings.$inferInsert;
