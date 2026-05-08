import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    category: text('category').notNull().default('general'),
    description: text('description').notNull(),
    /** Markdown content — Claude Code-style skill definition. When set, used directly as the prompt fragment. */
    content: text('content').default(''),
    principles: jsonb('principles').$type<string[]>().notNull().default([]),
    bestPractices: jsonb('best_practices').$type<string[]>().notNull().default([]),
    antiPatterns: jsonb('anti_patterns').$type<string[]>().notNull().default([]),
    frameworks: jsonb('frameworks').$type<string[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Org-shared skill. NULL = personal/system. Members of the org see this row alongside their own. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('skills_org_id_idx').on(table.orgId),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
