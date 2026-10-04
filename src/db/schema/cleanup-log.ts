import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const cleanupAuditLog = pgTable('cleanup_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Whose knowledge base the run cleaned (migration 0125). NULL user and
   * workspace = an install-wide run (scheduled job or audited admin route).
   */
  userId: uuid('user_id'),
  workspaceId: uuid('workspace_id'),
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index('cleanup_audit_log_created_at_idx').on(table.createdAt),
  userIdIdx: index('cleanup_audit_log_user_id_idx').on(table.userId),
}));

export type CleanupAuditEntry = typeof cleanupAuditLog.$inferSelect;
export type NewCleanupAuditEntry = typeof cleanupAuditLog.$inferInsert;
