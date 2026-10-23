import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organizations';
import { users } from './users';

/**
 * Cases ("Vorgänge", docs/CASES.md): one matter of business — an incoming
 * invoice, a complaint, an inquiry, a contract review — that people,
 * documents, tasks and notes hang off. The shared core every business module
 * builds on: a module contributes the `kind` and what gets linked, not its own
 * table.
 *
 * Scoped like `tasks`: `user_id` is the author (in a space, attribution only),
 * `workspace_id` NULL or personal means personal, a shared workspace means the
 * space's case, read by every member and written by editors.
 */
export const cases = pgTable('cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  /**
   * What kind of matter this is ("invoice", "complaint", "inquiry"). Free
   * text, like `tasks.category`: modules and plugins name their own kinds.
   */
  kind: text('kind'),
  /** 'open' | 'waiting' | 'done' | 'archived' — see core/cases/status.ts. */
  status: text('status').default('open').notNull(),
  summary: text('summary'),
  /** The person responsible: the owner personally, a member (not a guest) in a space. */
  assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Provenance: 'user' | 'agent' | 'email' | 'plugin' | … (free text). */
  source: text('source').default('user').notNull(),
  sourceRef: jsonb('source_ref').$type<CaseSourceRef>(),
  /**
   * The id of the matter in the system it came from ("datev:4711",
   * "mail:<message-id>"). Unique per scope, so a connector that reports the
   * same matter twice gets the first case back (`CaseRepo.createOnce`).
   */
  externalKey: text('external_key'),
  /** 1-4 (docs/PROTECTION-LEVELS.md); null is unclear and counts as 4. */
  protectionLevel: smallint('protection_level'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userStatusIdx: index('cases_user_status_idx').on(table.userId, table.status, table.updatedAt),
  workspaceStatusIdx: index('cases_workspace_status_idx').on(table.workspaceId, table.status, table.updatedAt),
  externalKeyIdx: uniqueIndex('cases_external_key_idx')
    .on(sql`coalesce(${table.workspaceId}::text, ${table.userId}::text)`, table.externalKey)
    .where(sql`${table.externalKey} IS NOT NULL`),
}));

export interface CaseSourceRef {
  sessionId?: string;
  messageId?: string;
  url?: string;
  /** The plugin or connector that reported the matter. */
  connector?: string;
  /** Free-form label, e.g. the email subject. */
  label?: string;
}

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;

/**
 * What a case links to (docs/CASES.md). One row per (case, entity). The
 * entity tables vary, so `entity_id` carries no foreign key: a link is made
 * only to an entity the linking principal can reach (core/cases/links.ts),
 * and a read drops links whose entity is gone or out of reach. Deleting the
 * case deletes its links.
 */
export const caseLinks = pgTable('case_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => cases.id, { onDelete: 'cascade' }).notNull(),
  /** 'contact' | 'document' | 'task' | 'note' | 'artifact' | 'record' — see core/cases/status.ts. */
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  /** What the entity is to the case ("client", "sender", "invoice", "follow_up"). Free text. */
  role: text('role'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueLink: uniqueIndex('case_links_unique_idx').on(table.caseId, table.entityType, table.entityId),
  entityIdx: index('case_links_entity_idx').on(table.entityType, table.entityId),
}));

export type CaseLink = typeof caseLinks.$inferSelect;
export type NewCaseLink = typeof caseLinks.$inferInsert;
