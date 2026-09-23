import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/** Personal exclusions for shared/system and mounted skills; source files remain untouched. */
export const hiddenSkills = pgTable('hidden_skills', {
  userId: text('user_id').notNull(),
  skillId: text('skill_id').notNull(),
}, table => ({ pk: primaryKey({ columns: [table.userId, table.skillId] }) }));
