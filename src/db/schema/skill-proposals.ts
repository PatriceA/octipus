import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { skills } from './skills';

export const skillProposalStatusEnum = pgEnum('skill_proposal_status',
  ['pending', 'approved', 'rejected', 'promoted']);

/**
 * What an approved proposal promotes into. Distilled *procedures* become
 * skills (SKILL.md-style DB rows); distilled *specialists* become experts.
 * Defaults to 'expert' so pre-existing rows and the legacy auto-extension
 * path keep their current behaviour. A 'patch' replaces exactly one passage
 * of an existing learned skill (`targetSkillId`) instead of creating one.
 */
export const skillProposalKindEnum = pgEnum('skill_proposal_kind', ['skill', 'expert', 'patch']);

export const skillProposals = pgTable('skill_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  draftPromptTemplate: text('draft_prompt_template').notNull(),
  exemplarCount: integer('exemplar_count').notNull().default(0),
  lastExemplarAt: timestamp('last_exemplar_at', { withTimezone: true }).notNull(),
  status: skillProposalStatusEnum('status').notNull().default('pending'),
  /** Promote into a 'skill' or an 'expert' on approval. */
  kind: skillProposalKindEnum('kind').notNull().default('expert'),
  /** Optional provenance for a distilled proposal (trajectory id, dir, or URL). */
  sourceRef: text('source_ref'),
  rejectedUntil: timestamp('rejected_until', { withTimezone: true }),
  // ── kind 'patch' only (src/skills/patch.ts) ─────────────────────
  /** The learned skill the patch applies to. Deleting the skill deletes its patches. */
  targetSkillId: text('target_skill_id').references(() => skills.id, { onDelete: 'cascade' }),
  /** The passage to replace: must occur exactly once in the skill's content. */
  patchOldText: text('patch_old_text'),
  patchNewText: text('patch_new_text'),
  /** sha256 of the skill content the patch was made against; approval refuses when it changed. */
  baseContentHash: text('base_content_hash'),
  /** The skill an approval created, merged into or patched (NULL before migration 0191). */
  promotedSkillId: text('promoted_skill_id').references(() => skills.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('skill_proposals_user_idx').on(t.userId),
  fingerprintIdx: index('skill_proposals_fingerprint_idx').on(t.fingerprint),
  statusIdx: index('skill_proposals_status_idx').on(t.status),
  targetSkillIdx: index('skill_proposals_target_skill_idx').on(t.targetSkillId),
}));

export type SkillProposalRecord = typeof skillProposals.$inferSelect;
export type NewSkillProposalRecord = typeof skillProposals.$inferInsert;
