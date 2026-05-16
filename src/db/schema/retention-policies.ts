import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Memory-redesign Phase A.5 — per-purpose retention policy.
 *
 * Replaces the hardcoded "agent outputs older than 30 days get
 * deleted" sweep with a row-driven policy keyed on the `purpose`
 * column added in Phase A. The cleanup loop in
 * `src/core/rag/embeddings.ts` resolves the policy per purpose; the
 * defaults from `.octipus/memory-redesign-schema.sql` are inserted
 * by migration 0051 so an upgrade ships with sane retention out of
 * the box. Operators (and a future settings UI) can update rows in
 * place.
 *
 * Two prune axes:
 *   - max_age_days        — hard age cap. NULL = never age-prune.
 *   - lfu_min_access /
 *     lfu_min_age_days    — combined LFU: prune rows whose
 *                           access_count is below lfu_min_access AND
 *                           which are older than lfu_min_age_days.
 *                           Either NULL disables that axis.
 *
 * Notes is for the operator: documents *why* the policy is what it
 * is so future-you doesn't tweak a number without knowing the
 * intent.
 */

export const retentionPolicies = pgTable('retention_policies', {
  purpose: text('purpose').primaryKey(),
  maxAgeDays: integer('max_age_days'),
  lfuMinAccess: integer('lfu_min_access'),
  lfuMinAgeDays: integer('lfu_min_age_days'),
  notes: text('notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type RetentionPolicy = typeof retentionPolicies.$inferSelect;
export type NewRetentionPolicy = typeof retentionPolicies.$inferInsert;
