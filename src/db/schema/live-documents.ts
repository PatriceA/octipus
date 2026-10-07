import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { notes } from './notes';
import { workspaces } from './organizations';
import { users } from './users';

/**
 * Live documents (docs/plans/coworking-spec.md §7, S3) — migration
 * `0130_live_documents.sql`.
 *
 * A space note open in an editor lives in the document hub
 * (`src/core/docs/hub.ts`); what it persists lands in `notes` with a row
 * here. Space notes only: every row's workspace is a space.
 */

/** Where a revision came from. */
export type NoteRevisionOrigin =
  /** Keystrokes of the members editing the open note. */
  | 'live'
  /** A writer outside the editor (REST save, capture, meeting notes, an agent in direct mode). */
  | 'external'
  /** A member restored an older revision (written as a new one). */
  | 'restore'
  /** An accepted edit proposal. */
  | 'proposal';

export const noteRevisions = pgTable('note_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  noteId: uuid('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  bodySha256: text('body_sha256').notNull(),
  /** Every member whose updates are in this revision. */
  authors: uuid('authors').array().notNull().default(sql`'{}'::uuid[]`),
  /** The member an agent wrote this for (an agent's write in direct mode, an accepted proposal). */
  onBehalfOfUserId: uuid('on_behalf_of_user_id').references(() => users.id, { onDelete: 'set null' }),
  origin: text('origin').$type<NoteRevisionOrigin>().notNull(),
  /** For `restore`: the revision restored. */
  restoredFrom: uuid('restored_from'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  noteCreatedIdx: index('note_revisions_note_created_idx').on(table.noteId, table.createdAt),
  wsIdx: index('note_revisions_ws_idx').on(table.workspaceId),
}));

export type NoteRevision = typeof noteRevisions.$inferSelect;

export type NoteEditProposalAction = 'edit' | 'capture' | 'meeting' | 'archive';
export type NoteEditProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

/**
 * What an agent proposes to change in a space note (§7.4). One pending row
 * per note and agent session. Named so it does not clash with the
 * knowledge-graph link suggestions (`src/core/knowledge/suggestions.ts`).
 */
export const noteEditProposals = pgTable('note_edit_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  noteId: uuid('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The member the agent works for (its requester). */
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id'),
  /**
   * A proposer without a session: a member of another install (`remote:<user
   * id>`, docs/plans/federation-spec.md §7.3). One pending proposal per note
   * and `coalesce(session_id, proposer_key)`.
   */
  proposerKey: text('proposer_key'),
  agentId: text('agent_id'),
  action: text('action').$type<NoteEditProposalAction>().notNull().default('edit'),
  /** A new title, when the proposal changes it. */
  title: text('title'),
  /** The text the agent read (its base), kept for the three-way view. */
  baseBody: text('base_body').notNull(),
  baseSha256: text('base_sha256').notNull(),
  /** The proposed body. */
  body: text('body').notNull(),
  status: text('status').$type<NoteEditProposalStatus>().notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pendingUidx: uniqueIndex('note_edit_proposals_pending_key_uidx')
    .on(table.noteId, sql`(coalesce(${table.sessionId}::text, ${table.proposerKey}))`)
    .where(sql`${table.status} = 'pending'`),
  wsStatusIdx: index('note_edit_proposals_ws_status_idx').on(table.workspaceId, table.status),
}));

export type NoteEditProposal = typeof noteEditProposals.$inferSelect;

export type FileLeaseHolderKind = 'human' | 'agent';

/**
 * "Ben is editing" on a space file (§7.5): one holder per normalized path
 * (relative to the space's files root) until `expires_at`.
 */
export const fileLeases = pgTable('file_leases', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  holderUserId: uuid('holder_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  holderKind: text('holder_kind').$type<FileLeaseHolderKind>().notNull(),
  agentId: text('agent_id'),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).defaultNow().notNull(),
  renewedAt: timestamp('renewed_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.path] }),
  expiresIdx: index('file_leases_expires_idx').on(table.expiresAt),
}));

export type FileLease = typeof fileLeases.$inferSelect;
