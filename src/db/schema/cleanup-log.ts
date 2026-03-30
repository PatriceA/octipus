import { pgTable, text, timestamp, uuid, boolean, integer, index } from 'drizzle-orm/pg-core';

export const cleanupAuditLog = pgTable('cleanup_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggeredBy: text('triggered_by').notNull().default('manual'), // manual, scheduled, api
  dryRun: boolean('dry_run').notNull().default(false),
  maxAgeDays: integer('max_age_days').notNull().default(30),
  minContentLength: integer('min_content_length').notNull().default(50),
  orphanedDocuments: integer('orphaned_documents').notNull().default(0),
  staleAgentOutputs: integer('stale_agent_outputs').notNull().default(0),
  shortEntries: integer('short_entries').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0),
  totalRemoved: integer('total_removed').notNull().default(0),
  totalBefore: integer('total_before'),
  totalAfter: integer('total_after'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index('cleanup_audit_log_created_at_idx').on(table.createdAt),
}));

export type CleanupAuditEntry = typeof cleanupAuditLog.$inferSelect;
export type NewCleanupAuditEntry = typeof cleanupAuditLog.$inferInsert;
