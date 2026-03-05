import { pgTable, text, timestamp, uuid, jsonb, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';

export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull().default('engineering'),
  description: text('description').notNull(),
  principles: jsonb('principles').$type<string[]>().notNull().default([]),
  bestPractices: jsonb('best_practices').$type<string[]>().notNull().default([]),
  antiPatterns: jsonb('anti_patterns').$type<string[]>().notNull().default([]),
  frameworks: jsonb('frameworks').$type<string[]>().notNull().default([]),
  isSystem: boolean('is_system').notNull().default(false),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
