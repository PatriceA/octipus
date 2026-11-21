import { type AnyPgColumn, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { vector } from './embeddings';
import { skills } from './skills';

/**
 * 'candidate': filed by automatic learning, not shown yet (it has not been
 * seen in enough sessions, or a cap is reached). 'merged': absorbed into
 * another proposal (`mergedIntoId`). See docs/SESSION-LEARNING.md.
 */
export const skillProposalStatusEnum = pgEnum('skill_proposal_status',
  ['pending', 'approved', 'rejected', 'promoted', 'candidate', 'merged']);

/** What kind of evidence a proposal rests on, strongest first. */
export const SKILL_PROPOSAL_SIGNALS = ['correction', 'recovery', 'procedure'] as const;
export type SkillProposalSignal = typeof SKILL_PROPOSAL_SIGNALS[number];

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
  /** Observations merged into this proposal, the first included. */
  exemplarCount: integer('exemplar_count').notNull().default(1),
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
  // ── consolidation (migration 0197) ──────────────────────────────
  /** Embedding of `name\ndescription`; NULL until computed (src/skills/embedding-backfill.ts). Never served. */
  embedding: vector('embedding'),
  /** Every sourceRef merged in, newest last, capped at 50 (`sessionCountOf`). */
  sourceRefs: jsonb('source_refs').$type<string[]>().notNull().default([]),
  signal: text('signal').$type<SkillProposalSignal>(),
  /** The draft before the last merge. */
  previousDraft: text('previous_draft'),
  /** Status 'merged': the proposal this one was absorbed into. */
  mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => skillProposals.id, { onDelete: 'set null' }),
  /** When it became 'pending' (shown to the owner). */
  surfacedAt: timestamp('surfaced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('skill_proposals_user_idx').on(t.userId),
  fingerprintIdx: index('skill_proposals_fingerprint_idx').on(t.fingerprint),
  statusIdx: index('skill_proposals_status_idx').on(t.status),
  targetSkillIdx: index('skill_proposals_target_skill_idx').on(t.targetSkillId),
  mergedIntoIdx: index('skill_proposals_merged_into_idx').on(t.mergedIntoId),
}));

export type SkillProposalRecord = typeof skillProposals.$inferSelect;
export type NewSkillProposalRecord = typeof skillProposals.$inferInsert;
