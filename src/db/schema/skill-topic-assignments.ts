import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const skillTopicAssignments = pgTable(
  'skill_topic_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Includes filesystem-mounted ids. DB skill deletion is cascaded by trigger.
    skillId: text('skill_id').notNull(),
    topic: text('topic').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueSkillTopic: uniqueIndex('skill_topic_unique').on(table.skillId, table.topic),
  }),
);

export type SkillTopicAssignment = typeof skillTopicAssignments.$inferSelect;
export type NewSkillTopicAssignment = typeof skillTopicAssignments.$inferInsert;
