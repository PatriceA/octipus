import { sql } from 'drizzle-orm';
import { check, customType, index, integer, pgTable, real, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Memory-redesign Phase D — atomic, updatable long-term memories.
 *
 * Distinct from `embeddings` (RAG over arbitrary text) and from
 * `task_state` (workflow state per session). A `memories` row is one
 * atomic fact about the user, scoped to the user (and optionally to a
 * workspace and/or an agent role). The extractor/judge pipeline in
 * `src/core/memory/` produces these rows from conversation turns
 * after the user replies — see `.octipus/memory-redesign.md` Phase D.
 *
 * Update semantics
 * ────────────────
 * We never destructively edit a memory. When the LLM judge decides a
 * candidate fact updates an existing one, we INSERT a new row and
 * set `superseded_by` on the old. Active retrieval reads the
 * `memories_active` view (created in the migration) which filters
 * `superseded_by IS NULL AND (valid_until IS NULL OR valid_until > now())`.
 *
 * Why a separate vector column (not `embeddings`)
 * ───────────────────────────────────────────────
 * Memories are queried with a different semantic intent (small,
 * recall-precision-sensitive, scoped to one user) and a different
 * retention policy (preferences are persistent; embeddings rows age
 * out). Mixing them in one table would force every embeddings query
 * to filter by purpose AND user, and force memory recall to compete
 * with document chunks in the same index. Keeping them in different
 * tables means each query is cheap.
 */

// Mirror the bare `vector` custom type from embeddings.ts — keeping a
// local copy avoids an import cycle and lets the dimensions vary.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value.replace(/^\[|\]$/g, '').split(',').map(Number);
  },
});

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  /** Optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  /**
   * NULL = visible to every role. Otherwise the role id this memory
   * is scoped to (e.g. 'coding' for "user prefers 4-space indents").
   */
  agentScope: text('agent_scope'),
  /**
   * What kind of fact this is. Free-form text so a new kind doesn't
   * need a migration; the extractor prompt enumerates the canonical
   * set: preference | profile | relationship | skill_observation |
   * workflow_note.
   */
  factType: text('fact_type').notNull(),
  /** One atomic fact, one sentence. */
  content: text('content').notNull(),
  embedding: vector('embedding').notNull(),
  /** "<model>/<dim>" — same scheme as embeddings.embedding_version. */
  embeddingVersion: text('embedding_version').notNull(),
  /** Provenance. FK omitted on purpose: messages may be compacted away. */
  sourceMessageId: uuid('source_message_id'),
  /**
   * The owner's own words this fact rests on: a verbatim quote, checked
   * server-side against a cited `role='user'` message of this user before the
   * row was written (`src/core/memory/quote-basis.ts`), PII-redacted, at most
   * `MAX_SOURCE_QUOTE_CHARS`. NULL on rows written before migration 0190.
   */
  sourceQuote: text('source_quote'),
  /** What sort of thing the fact is (`MemoryKind`). NULL = unknown / older row. */
  kind: text('kind').$type<MemoryKind>(),
  /** How strongly the owner's words back it (`MemoryStatus`). NULL = older row. */
  status: text('status').$type<MemoryStatus>(),
  /**
   * When the fact itself stops being true, as the owner said it ("I'm in
   * Berlin until Friday"). Recall skips the row from then on, and the repair
   * pass retires it (`archive_reason = 'expired'`). NULL = no known end.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Why the row stopped being active (`MemoryArchiveReason`). NULL while active, after a manual delete, or on older rows. */
  archiveReason: text('archive_reason').$type<MemoryArchiveReason>(),
  /** LLM-extractor's confidence 0..1. Used to filter low-quality facts. */
  confidence: real('confidence').notNull().default(1.0),
  /** Soft TTL. NULL = persistent. */
  validUntil: timestamp('valid_until', { withTimezone: true }),
  /**
   * Self-FK. Non-NULL = this row was updated; the new row points at
   * the newer fact. ON DELETE SET NULL so a hard-deleted successor
   * doesn't cascade-delete history.
   */
  supersededBy: uuid('superseded_by').references((): AnyPgColumn => memories.id, { onDelete: 'set null' }),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('memories_user_idx').on(table.userId),
  // Partial index over ACTIVE memories — the hot read path always
  // filters `superseded_by IS NULL`, so excluding the supersession
  // tail from this index keeps it small. Realised by migration 0054
  // (the original 0053 index was full and is dropped there).
  activeIdx: index('memories_user_scope_type_active_idx')
    .on(table.userId, table.agentScope, table.factType)
    .where(sql`${table.supersededBy} IS NULL`),
  workspaceIdx: index('memories_workspace_idx').on(table.workspaceId),
  supersededIdx: index('memories_superseded_by_idx').on(table.supersededBy),
  validUntilIdx: index('memories_valid_until_idx').on(table.validUntil),
  expiresAtIdx: index('memories_expires_at_idx').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  kindCheck: check('memories_kind_check', sql`${table.kind} IS NULL OR ${table.kind} IN ('fact', 'preference', 'plan', 'event', 'possession')`),
  statusCheck: check('memories_status_check', sql`${table.status} IS NULL OR ${table.status} IN ('tentative', 'observed', 'stated')`),
  archiveReasonCheck: check('memories_archive_reason_check', sql`${table.archiveReason} IS NULL OR ${table.archiveReason} IN ('superseded', 'contradicted', 'expired', 'merged', 'stale')`),
  sourceQuoteCheck: check('memories_source_quote_len_check', sql`${table.sourceQuote} IS NULL OR char_length(${table.sourceQuote}) <= 400`),
}));

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
/** A memory as the read paths return it: without the vector, which none of them uses. */
export type MemoryRecord = Omit<Memory, 'embedding'>;

/** Longest stored `source_quote` (the column's CHECK constraint). */
export const MAX_SOURCE_QUOTE_CHARS = 400;

export const MEMORY_KINDS = ['fact', 'preference', 'plan', 'event', 'possession'] as const;
/** A plan or an event is the kind of fact that ends; the others usually hold until changed. */
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * tentative — one owner message said it; observed — more than one did;
 * stated — the owner asked for it to be remembered (`remember_this`).
 */
export type MemoryStatus = 'tentative' | 'observed' | 'stated';

/**
 * Why a row was retired. superseded: a newer fact replaced it; contradicted:
 * the owner said it is no longer true; expired: its `expires_at` passed;
 * merged: an exact duplicate of another row (repair pass); stale: reserved
 * for an age-based pass, which does not exist yet.
 */
export type MemoryArchiveReason = 'superseded' | 'contradicted' | 'expired' | 'merged' | 'stale';

export type MemoryFactType =
  | 'preference'
  | 'profile'
  | 'relationship'
  | 'skill_observation'
  | 'workflow_note';

// ── Standing value ───────────────────────────────────────────────────
//
// How the always-on half of the injected memory block is ordered. Two
// ingredients, and the second one is why this is not just `access_count DESC`.
//
// Frequency is taken as `ln(1 + access_count)` rather than the raw count: the
// difference between a fact recalled twice and one recalled ten times is real,
// the difference between forty and fifty is noise, and a linear count lets one
// long-running project's facts sit permanently above everything else.
//
// Recency then fades a fact that has not been reached for. Without it the
// score is a ratchet — whatever was useful during one project outranks
// everything learned since, for as long as the install lives. The fade is
// bounded (a floor of 1 - MAX_STANDING_DECAY) for the same reason the
// knowledge-base freshness factor is: it re-orders near-ties and lets a
// current fact win, but never buries a fact that is genuinely the most-used
// thing known about the user.
//
// `last_accessed_at` is NULL until a fact is first reached for, so the fade
// starts from `updated_at` — the moment the fact was learned. A fact written
// today therefore scores as freshly-relevant, which is the honest reading of
// "the user just told us this".

/** Floor of the recency multiplier: a long-untouched fact keeps half its value. */
export const MAX_STANDING_DECAY = 0.5;
/** Days over which the multiplier walks from 1.0 down to that floor. */
export const STANDING_HORIZON_DAYS = 180;

/**
 * `ln(1 + access_count)` scaled by that recency multiplier. Used by
 * `MemoryRepository.retrieveTop`, which selects from the bare table — hence
 * plain column references rather than the alias dance the embeddings
 * equivalent needs for its hand-written CTE.
 */
export const standingScoreSql = sql<number>`
  (1.0 + LN(1.0 + ${memories.accessCount}))
  * (1.0 - LEAST(${MAX_STANDING_DECAY}, ${MAX_STANDING_DECAY}
      * GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(${memories.lastAccessedAt}, ${memories.updatedAt}))) / 86400.0)
      / ${STANDING_HORIZON_DAYS}))
`;
