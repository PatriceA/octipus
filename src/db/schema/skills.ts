import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { vector } from './embeddings';
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
    /** Keyword/regex strings — case-insensitive substring match against user message during discovery. */
    triggers: jsonb('triggers').$type<string[]>().notNull().default([]),
    /** Embedding of `name + description` (768-dim, matches default embedding model). NULL until backfilled. */
    descriptionEmbedding: vector('description_embedding'),
    /** sha256(name + description) — used to detect staleness vs the current embedding. */
    descriptionHash: text('description_hash'),
    /** Bypass discovery — when true, skill is always injected for its topic regardless of message content. */
    alwaysInject: boolean('always_inject').notNull().default(false),
    // ── Curator lifecycle fields (Phase 4) ──────────────────────────
    /** Last time this skill was loaded into a prompt, set by the usage tracker. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Lifetime injection count, debounced-incremented by the usage tracker. */
    usageCount: integer('usage_count').notNull().default(0),
    /** Soft-archive flag: hidden from discovery but kept for audit. NULL = active. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Free-form notes left by the curator (auto-archive reason, refresh suggestion). */
    curationNotes: text('curation_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('skills_org_id_idx').on(table.orgId),
    /** Speeds up the curator's stale-detection scan: WHERE last_used_at < cutoff AND archived_at IS NULL. */
    lastUsedIdx: index('skills_last_used_idx').on(table.lastUsedAt),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
