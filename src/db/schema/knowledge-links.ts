import { index, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Knowledge-graph Tier 1 — explicit directed edges between knowledge
 * entities. See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * The fourth member of the "right primitive per layer" family that
 * `memory-redesign.md` started: `memories` (facts), `embeddings`
 * (documents), `task_state` (workflow), and now `knowledge_links`
 * (ideas & their relationships). Everything in Octipus before this was
 * either an intra-document FK (`embeddings.parent_chunk_id`), a
 * supersession chain (`memories.superseded_by`), or a *fuzzy* cosine
 * match computed at query time and never persisted. This table is the
 * first place two independent knowledge items are connected by an
 * authored, explainable edge — the `[[wikilink]]` model.
 *
 * Polymorphic by design
 * ─────────────────────
 * An edge connects two `(type, id)` pairs over entities that already
 * exist — `note`, `document`, `memory`, `artifact` — plus a free-text
 * `link_type` so a new relation never needs a migration (same
 * convention as `memories.fact_type` / `task_state.task_kind`). There
 * is no real FK on `from_id`/`to_id` because the target table varies;
 * referential cleanup is app-side (see `KnowledgeLinkRepository`).
 *
 * Directed, queried both ways
 * ───────────────────────────
 * One row per edge. Backlinks ("what links to X") = query the `to_*`
 * side; outgoing ("what does X link to") = query the `from_*` side. No
 * reverse-row duplication.
 *
 * Unresolved wikilinks (Obsidian "ghost" targets)
 * ───────────────────────────────────────────────
 * A `[[Target]]` may point at something not yet created. We store the
 * edge with `to_id`/`to_type` NULL and `to_ref` holding the canonical
 * target (slug). A resolver binds `to_id`/`to_type` when the target is
 * later created. `to_ref` is therefore the dedup key (always present),
 * not `to_id` (NULL while unresolved).
 */

export const knowledgeLinks = pgTable('knowledge_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Owner. Every query filters on this. */
  userId: uuid('user_id').notNull(),
  /** Optional workspace scope. NULL = user-level. */
  workspaceId: uuid('workspace_id'),
  /** Source endpoint kind: note | document | memory | artifact (free text). */
  fromType: text('from_type').notNull(),
  fromId: uuid('from_id').notNull(),
  /** Target endpoint kind. NULL until an unresolved wikilink resolves. */
  toType: text('to_type'),
  /** Target id. NULL until resolved (Obsidian "ghost" target). */
  toId: uuid('to_id'),
  /**
   * Canonical target reference — slug, title, or id-string. The dedup
   * key and the value the resolver matches against when binding `to_id`.
   * Always present, even for unresolved (ghost) edges.
   */
  toRef: text('to_ref').notNull(),
  /**
   * Relationship kind: references | derived_from | contradicts |
   * mentions | child_of | tagged (free text — new kinds need no
   * migration).
   */
  linkType: text('link_type').notNull(),
  /** Optional edge label / wikilink alias. */
  label: text('label'),
  /** Provenance: user | agent | wikilink | suggestion. */
  origin: text('origin').notNull(),
  /** For agent/suggested edges; NULL for explicit user/wikilink edges. */
  confidence: real('confidence'),
  /** NULL = user-authored; else the agent id that created the edge. */
  createdByAgentId: text('created_by_agent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // An edge is unique by its *authored target* (`to_ref`), so dedup
  // works before and after resolution.
  uniqueEdge: uniqueIndex('knowledge_links_unique_edge_idx')
    .on(table.userId, table.fromType, table.fromId, table.toRef, table.linkType),
  // Backlinks — the killer query ("what links to X").
  toIdx: index('knowledge_links_to_idx').on(table.toType, table.toId),
  // Outgoing edges.
  fromIdx: index('knowledge_links_from_idx').on(table.fromType, table.fromId),
  userIdx: index('knowledge_links_user_idx').on(table.userId),
  workspaceIdx: index('knowledge_links_workspace_idx').on(table.workspaceId),
  // Unresolved-wikilink resolution sweep — only the ghost rows.
  unresolvedIdx: index('knowledge_links_unresolved_idx')
    .on(table.toRef)
    .where(sql`${table.toId} IS NULL`),
}));

export type KnowledgeLink = typeof knowledgeLinks.$inferSelect;
export type NewKnowledgeLink = typeof knowledgeLinks.$inferInsert;

/** Entities an edge can connect. Free text in the column; this is the canonical set. */
export type KnowledgeEntityType = 'note' | 'document' | 'memory' | 'artifact' | 'tag';

/** Canonical relationship kinds. Free text in the column; this is the canonical set. */
export type KnowledgeLinkType =
  | 'references'
  | 'derived_from'
  | 'contradicts'
  | 'mentions'
  | 'child_of'
  | 'tagged';

/** Provenance of an edge. */
export type KnowledgeLinkOrigin = 'user' | 'agent' | 'wikilink' | 'suggestion';
