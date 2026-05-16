import { sql } from 'drizzle-orm';
import { customType, index, integer, pgTable, real, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

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
}));

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

export type MemoryFactType =
  | 'preference'
  | 'profile'
  | 'relationship'
  | 'skill_observation'
  | 'workflow_note';
