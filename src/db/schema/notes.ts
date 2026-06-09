import { boolean, date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Knowledge-graph Tier 2 — authored markdown notes.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * Notes are the user-facing authoring surface the platform lacked:
 * `memories` are *passively extracted* from conversation and `embeddings`
 * are *ingested* from uploads/file writes — neither lets a user (or an
 * agent, deliberately) write a note and link it. A note is the one
 * entity that can link to everything else via `[[wikilinks]]`
 * (`knowledge_links`, Tier 1).
 *
 * Source of truth is Postgres (keeps multi-user scoping, retention, and
 * hybrid search consistent with the rest of the system) but the body is
 * plain markdown so it stays human- and model-readable and is exportable
 * to a real Obsidian vault later (Tier 3).
 *
 * On save, `NoteService` (1) re-links — parses `[[wikilinks]]`/`#tags`
 * and syncs `knowledge_links`; (2) re-indexes — chunks the body into
 * `embeddings` with `purpose='note'`, `source_id='note:<id>'` — so notes
 * are first-class hybrid-search hits with no new retrieval code.
 */

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  /** Optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  /** Wikilink target + URL slug. Unique per owner scope. */
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  /** Markdown body — the `[[wikilinks]]` live here. */
  body: text('body').notNull().default(''),
  /** SHA-256 of body — change detection so an unchanged save is a no-op. */
  bodySha256: text('body_sha256').notNull(),
  /** Obsidian-style properties (Bases input in Tier 3). */
  frontmatter: jsonb('frontmatter').$type<Record<string, unknown>>().notNull().default({}),
  /** Free-text folksonomy tags, denormalised from `#tags` for cheap filtering. */
  tags: text('tags').array().notNull().default([]),
  /** note | daily | moc | literature | … (free text, no migration for new kinds). */
  noteKind: text('note_kind').notNull().default('note'),
  /** For daily notes / journaling — the calendar day this note covers. */
  noteDate: date('note_date'),
  /** NULL = user-authored; else the agent id that created it. */
  createdByAgentId: text('created_by_agent_id'),
  pinned: boolean('pinned').notNull().default(false),
  /** Soft delete. Notes archive, never hard-delete by default. */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Slug must be unique per owner scope. Two partial unique indexes
  // because a plain unique index over (user, workspace, slug) would let
  // duplicate user-level slugs through — Postgres treats NULL workspace
  // values as distinct.
  slugUserIdx: uniqueIndex('notes_user_slug_uidx')
    .on(table.userId, table.slug)
    .where(sql`${table.workspaceId} IS NULL`),
  slugWorkspaceIdx: uniqueIndex('notes_user_ws_slug_uidx')
    .on(table.userId, table.workspaceId, table.slug)
    .where(sql`${table.workspaceId} IS NOT NULL`),
  kindIdx: index('notes_user_kind_idx').on(table.userId, table.noteKind),
  dateIdx: index('notes_date_idx').on(table.userId, table.noteDate),
  tagsIdx: index('notes_tags_idx').using('gin', table.tags),
  // Active-notes hot path (mirrors the memories_active partial-index pattern).
  activeIdx: index('notes_active_idx').on(table.userId, table.updatedAt).where(sql`${table.archivedAt} IS NULL`),
}));

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

/** Canonical note kinds. Free text in the column; this is the canonical set. */
export type NoteKind = 'note' | 'daily' | 'moc' | 'literature';
