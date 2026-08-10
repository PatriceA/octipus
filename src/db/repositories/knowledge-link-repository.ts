import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { WikiLink } from '@/core/knowledge/wikilink';
import { coreLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import {
  type KnowledgeLink,
  knowledgeLinks,
  type NewKnowledgeLink,
} from '../schema/knowledge-links';

/**
 * Knowledge-graph Tier 1 — CRUD + resolution for `knowledge_links`.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * Polymorphic edges have no real FK on their endpoints (the target table
 * varies), so referential cleanup is app-side: `deleteForEntity` is
 * called from each entity repository's delete path, and a periodic sweep
 * (`reapUnacceptedSuggestions`) handles stale suggestions.
 */
export class KnowledgeLinkRepository {
  private get db() {
    return getDb();
  }

  /**
   * Create or update an edge. Dedup is by the authored target — the
   * unique index on (user_id, from_type, from_id, to_ref, link_type) —
   * so re-asserting an existing edge refreshes its label/origin/
   * confidence rather than erroring.
   *
   * Resolution semantics: on conflict, a non-null `record.toId`/`toType`
   * *binds* a previously-ghost edge (resolves it); passing `null` keeps
   * whatever is already stored — it does NOT clear an existing binding.
   * To revert an edge to ghost state use `deleteForEntity` (which calls
   * the private `unbindInbound`), not `create`.
   */
  async create(
    record: Omit<NewKnowledgeLink, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<KnowledgeLink> {
    const result = await this.db
      .insert(knowledgeLinks)
      .values(record)
      .onConflictDoUpdate({
        target: [
          knowledgeLinks.userId,
          knowledgeLinks.fromType,
          knowledgeLinks.fromId,
          knowledgeLinks.toRef,
          knowledgeLinks.linkType,
        ],
        set: {
          label: record.label ?? null,
          origin: record.origin,
          confidence: record.confidence ?? null,
          // Re-binding an edge that was previously a ghost resolves it;
          // null preserves the existing binding (see JSDoc above).
          toId: record.toId ?? sql`${knowledgeLinks.toId}`,
          toType: record.toType ?? sql`${knowledgeLinks.toType}`,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!result[0]) {
      // Should be unreachable — insert-or-update always returns the row.
      throw new Error('knowledge_links upsert returned no row');
    }
    return result[0];
  }

  async getById(id: string): Promise<KnowledgeLink | null> {
    const rows = await this.db.select().from(knowledgeLinks).where(eq(knowledgeLinks.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Outgoing edges from an entity ("what does X link to"), tenant-scoped. */
  async getOutgoing(userId: string, fromType: string, fromId: string): Promise<KnowledgeLink[]> {
    return this.db
      .select()
      .from(knowledgeLinks)
      .where(and(eq(knowledgeLinks.userId, userId), eq(knowledgeLinks.fromType, fromType), eq(knowledgeLinks.fromId, fromId)));
  }

  /** Backlinks — resolved edges pointing at an entity ("what links to X"), tenant-scoped. */
  async getBacklinks(userId: string, toType: string, toId: string): Promise<KnowledgeLink[]> {
    return this.db
      .select()
      .from(knowledgeLinks)
      .where(and(eq(knowledgeLinks.userId, userId), eq(knowledgeLinks.toType, toType), eq(knowledgeLinks.toId, toId)));
  }

  /**
   * Backlinks by canonical ref — catches both resolved and unresolved
   * (ghost) edges. Used to render a note's backlinks by slug, and to
   * list every entity carrying a given tag (`toRef = tag`).
   */
  async getBacklinksByRef(userId: string, toRef: string): Promise<KnowledgeLink[]> {
    return this.db
      .select()
      .from(knowledgeLinks)
      .where(and(eq(knowledgeLinks.userId, userId), eq(knowledgeLinks.toRef, toRef)));
  }

  /** Resolved outgoing edges for a batch of source ids — the BFS step. Tenant-scoped. */
  async outgoingForIds(userId: string, fromType: string, fromIds: string[]): Promise<KnowledgeLink[]> {
    if (fromIds.length === 0) return [];
    return this.db
      .select()
      .from(knowledgeLinks)
      .where(and(eq(knowledgeLinks.userId, userId), eq(knowledgeLinks.fromType, fromType), inArray(knowledgeLinks.fromId, fromIds)));
  }

  /** Resolved backlink edges for a batch of target ids — the reverse BFS step. Tenant-scoped. */
  async backlinksForIds(userId: string, toType: string, toIds: string[]): Promise<KnowledgeLink[]> {
    if (toIds.length === 0) return [];
    return this.db
      .select()
      .from(knowledgeLinks)
      .where(and(eq(knowledgeLinks.userId, userId), eq(knowledgeLinks.toType, toType), inArray(knowledgeLinks.toId, toIds)));
  }

  /**
   * Replace the set of `origin='wikilink'` edges authored by a source
   * entity to match the parsed wikilinks + tags of its current body.
   * Idempotent: unchanged bodies produce no writes. Returns the counts
   * so callers can log/trace.
   */
  async syncWikilinks(params: {
    userId: string;
    workspaceId?: string | null;
    fromType: string;
    fromId: string;
    wikilinks: WikiLink[];
    tags: string[];
    createdByAgentId?: string | null;
  }): Promise<{ added: number; removed: number }> {
    const { userId, workspaceId, fromType, fromId, wikilinks, tags, createdByAgentId } = params;

    // Desired edge set, keyed by `${linkType}:${toRef}` (the part of the
    // unique index that varies within one source). Tier 1 tracks
    // note-level edges, not heading-level: `[[A#Intro]]` and `[[A#Risks]]`
    // from the same source collapse to one `references` edge to `a` (the
    // Map key dedups them here). `WikiLink.heading` is preserved by the
    // parser for display but is intentionally not part of the edge identity.
    const desired = new Map<string, Omit<NewKnowledgeLink, 'id' | 'createdAt' | 'updatedAt'>>();
    for (const link of wikilinks) {
      desired.set(`references:${link.ref}`, {
        userId,
        workspaceId: workspaceId ?? null,
        fromType,
        fromId,
        toType: null,
        toId: null,
        toRef: link.ref,
        linkType: 'references',
        label: link.alias ?? null,
        origin: 'wikilink',
        createdByAgentId: createdByAgentId ?? null,
      });
    }
    for (const tag of tags) {
      desired.set(`tagged:${tag}`, {
        userId,
        workspaceId: workspaceId ?? null,
        fromType,
        fromId,
        toType: 'tag',
        toId: null,
        toRef: tag,
        linkType: 'tagged',
        label: null,
        origin: 'wikilink',
        createdByAgentId: createdByAgentId ?? null,
      });
    }

    const existing = await this.db
      .select()
      .from(knowledgeLinks)
      .where(
        and(
          eq(knowledgeLinks.userId, userId),
          eq(knowledgeLinks.fromType, fromType),
          eq(knowledgeLinks.fromId, fromId),
          eq(knowledgeLinks.origin, 'wikilink'),
        ),
      );
    const existingKeys = new Set(existing.map((e) => `${e.linkType}:${e.toRef}`));

    const toRemove = existing.filter((e) => !desired.has(`${e.linkType}:${e.toRef}`));
    const toAdd = [...desired.entries()].filter(([key]) => !existingKeys.has(key)).map(([, v]) => v);

    if (toRemove.length > 0) {
      await this.db.delete(knowledgeLinks).where(
        inArray(knowledgeLinks.id, toRemove.map((e) => e.id)),
      );
    }
    if (toAdd.length > 0) {
      // onConflictDoNothing: a concurrent writer may have inserted the
      // same authored edge; that's fine, it's the same edge.
      await this.db.insert(knowledgeLinks).values(toAdd).onConflictDoNothing();
    }

    return { added: toAdd.length, removed: toRemove.length };
  }

  /**
   * Bind ghost edges (`to_id IS NULL`) whose `to_ref` matches a
   * now-existing entity. Called when an entity is created or renamed.
   * Returns the number of edges resolved.
   *
   * `confidence` marks a *guessed* binding (see `LinkResolverService`): the
   * `to_ref` never named this target exactly, similarity did. Such an edge is
   * still re-bindable, so an exact-slug resolution later takes it back — an
   * exact match always outranks a guess. An exact binding (no `confidence`)
   * clears any prior guess score, and is never overwritten by another one.
   */
  async resolveTo(params: {
    userId: string;
    toRef: string;
    toType: string;
    toId: string;
    /** Retrieval score when the binding is a similarity guess; omit for exact. */
    confidence?: number;
  }): Promise<number> {
    const { userId, toRef, toType, toId, confidence } = params;
    const isGuess = confidence !== undefined;
    const result = await this.db
      .update(knowledgeLinks)
      .set({
        toType,
        toId,
        // Exact bindings clear a reclaimed guess score but must leave the
        // confidence of an agent/suggestion ghost edge alone.
        confidence: isGuess
          ? confidence
          : sql`CASE WHEN ${knowledgeLinks.origin} = 'wikilink' THEN NULL ELSE ${knowledgeLinks.confidence} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeLinks.userId, userId),
          eq(knowledgeLinks.toRef, toRef),
          isGuess
            // A guess only ever fills an empty slot on an authored wikilink;
            // it must not displace an exact binding, churn a previous guess,
            // or touch an agent/suggestion edge (whose `confidence` means
            // something else entirely).
            ? and(isNull(knowledgeLinks.toId), eq(knowledgeLinks.origin, 'wikilink'))
            // An exact match binds ghosts AND reclaims what a guess bound —
            // scoped to wikilink edges so an agent edge that legitimately
            // carries a confidence is never repointed.
            : sql`(${knowledgeLinks.toId} IS NULL OR (${knowledgeLinks.confidence} IS NOT NULL AND ${knowledgeLinks.origin} = 'wikilink'))`,
          // `tagged` edges are intentionally never resolved to an id —
          // a tag is a pseudo-entity, not a row.
          sql`${knowledgeLinks.linkType} <> 'tagged'`,
        ),
      )
      .returning({ id: knowledgeLinks.id });
    return result.length;
  }

  /**
   * Revert edges that point at a deleted entity back to ghost state
   * (clear `to_id`/`to_type`) instead of dropping them — the authored
   * intent survives and re-resolves if the target is recreated. Used by
   * `deleteForEntity` for the inbound side.
   */
  private async unbindInbound(toType: string, toId: string): Promise<number> {
    const result = await this.db
      .update(knowledgeLinks)
      .set({ toId: null, toType: null, updatedAt: new Date() })
      .where(and(eq(knowledgeLinks.toType, toType), eq(knowledgeLinks.toId, toId)))
      .returning({ id: knowledgeLinks.id });
    return result.length;
  }

  /**
   * App-side referential cleanup when an entity is deleted. Outbound
   * edges (the entity as source) are dropped; inbound edges (the entity
   * as target) revert to ghost so the backlink isn't silently lost.
   * Returns { dropped, unbound }.
   */
  async deleteForEntity(entityType: string, entityId: string): Promise<{ dropped: number; unbound: number }> {
    const dropped = await this.db
      .delete(knowledgeLinks)
      .where(and(eq(knowledgeLinks.fromType, entityType), eq(knowledgeLinks.fromId, entityId)))
      .returning({ id: knowledgeLinks.id });
    const unbound = await this.unbindInbound(entityType, entityId);
    return { dropped: dropped.length, unbound };
  }

  /** Delete a single edge by id. */
  async delete(id: string): Promise<void> {
    await this.db.delete(knowledgeLinks).where(eq(knowledgeLinks.id, id));
  }

  /**
   * Retention sweep — drop suggestion edges the user never accepted.
   * Accepted suggestions are rewritten to `origin='user'`, so anything
   * still tagged `suggestion` past the cutoff is noise. Returns count.
   */
  async reapUnacceptedSuggestions(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(knowledgeLinks)
      .where(and(eq(knowledgeLinks.origin, 'suggestion'), lt(knowledgeLinks.createdAt, cutoff)))
      .returning({ id: knowledgeLinks.id });
    if (result.length > 0) {
      coreLogger.info({ component: 'knowledge-links', count: result.length, cutoff }, 'Reaped unaccepted suggestion edges');
    }
    return result.length;
  }

  /**
   * Orphan reaper — drop edges whose *resolved* endpoints reference a row
   * that no longer exists. Polymorphic, so this can't be a FK cascade;
   * the per-entity `deleteForEntity` is the primary path and this is the
   * backstop for rows deleted out-of-band. Scoped to the entity types we
   * can check cheaply (note, document, artifact, memory).
   */
  async countUnresolved(userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(knowledgeLinks)
      .where(
        and(
          eq(knowledgeLinks.userId, userId),
          isNull(knowledgeLinks.toId),
          or(eq(knowledgeLinks.linkType, 'references'), eq(knowledgeLinks.linkType, 'derived_from')),
        ),
      );
    return rows[0]?.c ?? 0;
  }
}

let _instance: KnowledgeLinkRepository | null = null;
export function getKnowledgeLinkRepository(): KnowledgeLinkRepository {
  if (!_instance) _instance = new KnowledgeLinkRepository();
  return _instance;
}
