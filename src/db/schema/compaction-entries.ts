import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';

/**
 * Cumulative file-operation tracker carried across compaction passes.
 * Each pass merges new ops on top of the previous entry's bag.
 */
export interface CompactionFileOps {
  read: string[];
  written: string[];
  edited: string[];
}

/**
 * One row per successful compaction pass. Replaces the old "single rolling
 * `compactedSummary` string in session.context" model with an append-only log
 * that supports iterative summary chaining, debugging, and (later) tree-aware
 * branch summarization.
 *
 * The newest entry's `summary` is what the root agent injects as the
 * pre-history system message; older entries remain for audit + chaining.
 */
export const compactionEntries = pgTable('compaction_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .references(() => sessions.id, { onDelete: 'cascade' })
    .notNull(),
  /**
   * Previous compaction entry whose summary was passed in to seed this one.
   * Null on the first compaction of a session.
   */
  parentEntryId: uuid('parent_entry_id'),
  /** The summary text produced by the LLM. */
  summary: text('summary').notNull(),
  /** Cumulative file ops (newer overwrites by path). */
  fileOps: jsonb('file_ops').$type<CompactionFileOps>().notNull().default({ read: [], written: [], edited: [] }),
  /**
   * Optional `/compact <instructions>` payload that focused this pass.
   */
  userInstructions: text('user_instructions'),
  tokensBefore: integer('tokens_before').notNull(),
  tokensAfter: integer('tokens_after').notNull(),
  savingsRatio: real('savings_ratio').notNull(),
  /** Number of source messages collapsed into the summary. */
  messagesSummarized: integer('messages_summarized').notNull().default(0),
  /**
   * Free-form reason from the decision function (first-pass, growth-threshold,
   * hard-ceiling, no-prior-stall). Useful for analytics.
   */
  triggerReason: text('trigger_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sessionIdx: index('compaction_entries_session_idx').on(t.sessionId),
  sessionCreatedIdx: index('compaction_entries_session_created_idx').on(t.sessionId, t.createdAt),
}));

export type CompactionEntryRecord = typeof compactionEntries.$inferSelect;
export type NewCompactionEntryRecord = typeof compactionEntries.$inferInsert;
