import { pgTable, text, boolean, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { skills } from './skills';

export const skillTopicAssignments = pgTable(
  'skill_topic_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueSkillTopic: uniqueIndex('skill_topic_unique').on(table.skillId, table.topic),
  }),
);

export type SkillTopicAssignment = typeof skillTopicAssignments.$inferSelect;
export type NewSkillTopicAssignment = typeof skillTopicAssignments.$inferInsert;
