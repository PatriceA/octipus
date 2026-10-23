import { boolean, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organizations';
import { users } from './users';

/**
 * Scan folders (docs/SCAN-FOLDERS.md): a directory on the server that a
 * scanner, a fax-to-file service or a network share drops files into. Each
 * file is filed into the documents of the folder's scope and removed from
 * the folder (the document keeps it).
 * Set up by admins only (the path is the server's file system). Scoped like
 * `cases`: `user_id` is the admin who set it up, and the documents are
 * written as them; `workspace_id` decides personal or a space.
 */
export const scanFolders = pgTable('scan_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  label: text('label').notNull(),
  /** The directory, as resolved at save (no symbolic link in it). */
  path: text('path').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  /** The protection level new content of this source starts at (docs/PROTECTION-LEVELS.md); null: unclear. */
  defaultProtectionLevel: smallint('default_protection_level'),
  lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
  lastError: text('last_error'),
  /** Files filed in all. */
  filed: integer('filed').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('scan_folders_user_idx').on(table.userId),
  workspaceIdx: index('scan_folders_workspace_idx').on(table.workspaceId),
  pathIdx: uniqueIndex('scan_folders_path_idx').on(table.path),
}));

/**
 * What a folder already handled. A filed file is keyed by its content
 * (`sha256:<hex>`): the same scan dropped twice is filed once. A file that
 * could not be filed is keyed by name, size and change time
 * (`failed:<name>:<size>:<ctime>`): it stays in the folder and is not tried
 * again until it changes.
 */
export const scanFolderFiles = pgTable('scan_folder_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  folderId: uuid('folder_id').references(() => scanFolders.id, { onDelete: 'cascade' }).notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  documentId: uuid('document_id'),
  /** Why it could not be filed (a `failed:` row). */
  error: text('error'),
  filedAt: timestamp('filed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  keyIdx: uniqueIndex('scan_folder_files_key_idx').on(table.folderId, table.key),
}));

export type ScanFolder = typeof scanFolders.$inferSelect;
export type NewScanFolder = typeof scanFolders.$inferInsert;
