import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
/** Permanent project reservations survive down so volumes cannot be adopted by another repo. */
export const dockerProjectOwners = pgTable('docker_project_owners', {
  identity: text('identity').primaryKey(),
  repoPath: text('repo_path').notNull(),
  userId: text('user_id').notNull(),
  workspaceId: text('workspace_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
