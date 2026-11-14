import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Content that was NOT indexed because no embedding model was configured
 * (src/core/capabilities/gates.ts: without one nothing is chunked or
 * embedded). When an embedding model is bound, the catch-up job
 * (src/core/rag/index-backlog.ts) chunks and embeds exactly these items and
 * deletes their rows; it never touches content that is already embedded.
 *
 * kind = document: source_id is the document id; its text is
 * `documents.ocr_text`, `purpose` the purpose it would have been stored under.
 * kind = note: source_id is the note id. kind = repo: the repository id,
 * re-scanned by `indexRepoKnowledge`.
 */
export const indexBacklog = pgTable('index_backlog', {
  kind: text('kind').$type<'document' | 'note' | 'repo'>().notNull(),
  sourceId: text('source_id').notNull(),
  /** Whose knowledge base it goes into. */
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id'),
  purpose: text('purpose'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.kind, table.sourceId] }),
  ownerIdx: index('index_backlog_owner_idx').on(table.ownerUserId),
}));

export type IndexBacklogRow = typeof indexBacklog.$inferSelect;
