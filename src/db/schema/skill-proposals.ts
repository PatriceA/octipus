import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const skillProposalStatusEnum = pgEnum('skill_proposal_status',
  ['pending', 'approved', 'rejected', 'promoted']);

export const skillProposals = pgTable('skill_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  draftPromptTemplate: text('draft_prompt_template').notNull(),
  exemplarCount: integer('exemplar_count').notNull().default(0),
  lastExemplarAt: timestamp('last_exemplar_at').notNull(),
  status: skillProposalStatusEnum('status').notNull().default('pending'),
  rejectedUntil: timestamp('rejected_until'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx: index('skill_proposals_user_idx').on(t.userId),
  fingerprintIdx: index('skill_proposals_fingerprint_idx').on(t.fingerprint),
  statusIdx: index('skill_proposals_status_idx').on(t.status),
}));

export type SkillProposalRecord = typeof skillProposals.$inferSelect;
export type NewSkillProposalRecord = typeof skillProposals.$inferInsert;
