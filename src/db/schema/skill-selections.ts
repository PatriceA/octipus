import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/** Empty scope is a user default; otherwise scope is a session id. Includes mounted skills. */
export const skillSelections = pgTable('skill_selections', {
  userId: text('user_id').notNull(),
  scope: text('scope').notNull().default(''),
  skillId: text('skill_id').notNull(),
  mode: text('mode').$type<'automatic' | 'always' | 'session'>().notNull(),
}, table => ({ pk: primaryKey({ columns: [table.userId, table.scope, table.skillId] }) }));
