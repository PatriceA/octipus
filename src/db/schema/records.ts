import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { FieldDef, RecordData } from '@/shared/record-fields';
import { workspaces } from './organizations';
import { users } from './users';

/**
 * Record types (docs/RECORDS.md): the kinds of structured data a business
 * keeps — "invoice" with an amount and a due date, "vehicle" with a plate
 * and a leasing end. A type is data: a module or a plugin defines it, and
 * every record of it is validated against its `fields`
 * (core/records/fields.ts).
 *
 * Scoped like `cases`: `user_id` is the author, `workspace_id` decides
 * personal or space. `key` is unique per scope.
 */
export const recordTypes = pgTable('record_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  fields: jsonb('fields').$type<FieldDef[]>().default([]).notNull(),
  /** The field a record's title is taken from; else its first filled text field. */
  titleField: text('title_field'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  keyIdx: uniqueIndex('record_types_key_idx').on(sql`coalesce(${table.workspaceId}::text, ${table.userId}::text)`, table.key),
  workspaceIdx: index('record_types_workspace_idx').on(table.workspaceId),
}));

export type RecordType = typeof recordTypes.$inferSelect;
export type NewRecordType = typeof recordTypes.$inferInsert;

/**
 * Records: one row of structured data of a type. Linked to cases through
 * `case_links` (entity type `record`), like documents and contacts. A type
 * with records cannot be deleted (RESTRICT): its records would lose their
 * meaning.
 */
export const records = pgTable('records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  typeId: uuid('type_id').references(() => recordTypes.id, { onDelete: 'restrict' }).notNull(),
  /** Derived from the data on every write (`recordTitle`). */
  title: text('title'),
  data: jsonb('data').$type<RecordData>().default({}).notNull(),
  /** Provenance: 'user' | 'agent' | 'form' | 'plugin' | … (free text). */
  source: text('source').default('user').notNull(),
  sourceRef: jsonb('source_ref').$type<RecordSourceRef>(),
  /** The id of the record in the system it came from; unique per scope. */
  externalKey: text('external_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index('records_type_idx').on(table.typeId, table.updatedAt),
  workspaceIdx: index('records_workspace_idx').on(table.workspaceId),
  externalKeyIdx: uniqueIndex('records_external_key_idx')
    .on(sql`coalesce(${table.workspaceId}::text, ${table.userId}::text)`, table.externalKey)
    .where(sql`${table.externalKey} IS NOT NULL`),
}));

export interface RecordSourceRef {
  sessionId?: string;
  /** The form link a submission came through. */
  formLinkId?: string;
  connector?: string;
  label?: string;
}

export type RecordRow = typeof records.$inferSelect;
export type NewRecordRow = typeof records.$inferInsert;

/**
 * Form links (docs/RECORDS.md → Forms): a URL people outside the install
 * fill in — an application, a callback request — that saves a record of
 * one type, and optionally opens a case for it. `token_hash` is
 * sha256(token); the raw token exists only in the response that mints the
 * link. A submission writes as the link's creator, re-checked on every
 * submission: a creator who may no longer write in the scope turns the link
 * dead.
 */
export const formLinks = pgTable('form_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordTypeId: uuid('record_type_id').references(() => recordTypes.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: text('token_hash').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** Shown above the form. */
  title: text('title').notNull(),
  intro: text('intro'),
  /** When set, each submission opens a case of this kind and links the record to it. */
  caseKind: text('case_kind'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxSubmissions: integer('max_submissions'),
  submissionCount: integer('submission_count').default(0).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenHashIdx: uniqueIndex('form_links_token_hash_idx').on(table.tokenHash),
  typeIdx: index('form_links_type_idx').on(table.recordTypeId),
}));

export type FormLink = typeof formLinks.$inferSelect;
export type NewFormLink = typeof formLinks.$inferInsert;
