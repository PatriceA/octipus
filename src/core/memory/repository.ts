/**
 * Memory-redesign Phase D — typed CRUD over the `memories` table.
 *
 * Notes on the public API
 * ───────────────────────
 *   - `addNew`        — insert a fresh fact (`status=active`, no
 *                       supersession).
 *   - `supersede`     — atomically: insert a new fact, link the old
 *                       row's `superseded_by` to the new id. The two
 *                       writes share a transaction so a crash mid-way
 *                       cannot leave a dangling pointer.
 *   - `softDelete`    — set `valid_until = now()` on an existing row.
 *                       Active retrieval drops it on next read. We
 *                       prefer this over a destructive DELETE so the
 *                       audit trail survives and the LLM judge can
 *                       still see "this fact existed and was removed".
 *   - `searchSimilar` — vector-only top-k over active memories,
 *                       scoped to `(userId, factType, agentScope?)`.
 *                       Used by the judge to find supersedable rows.
 *   - `retrieveTop`   — turn-start fetch: top-N active memories
 *                       across the visible scopes, ordered by
 *                       access_count + recency.
 *   - `retrieveRelevant`
 *                     — the same fetch ordered by distance from the
 *                       turn instead. The retrieval module is what
 *                       callers invoke; these two are its primitives.
 *   - `recordAccess`  — fire-and-forget bump of access_count +
 *                       last_accessed_at. Same shape as the
 *                       EmbeddingService LFU signal.
 */

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type Memory, memories, type NewMemory } from '@/db/schema/memories';
import { coreLogger } from '@/utils/logger';

export type MemoryAccessScope = {
  userId: string;
  /** Role id for per-role scoping. NULL = caller wants user-level + global. */
  agentScope?: string | null;
  /**
   * Workspace (project / client) the turn runs in. Mirrors `workspaceFilter`
   * in `db/repositories/scoped.ts`: when set, only rows written under this
   * workspace OR under no workspace (user-level facts) are returned. When
   * null/undefined the caller has no workspace context and every row the
   * user owns is eligible — the same "no scope, no filter" rule the scoped
   * repositories apply, so a path that cannot resolve a workspace degrades to
   * the pre-scoping behaviour instead of silently hiding memories.
   */
  workspaceId?: string | null;
};

export class MemoryRepository {
  private get db() { return getDb(); }

  async addNew(record: Omit<NewMemory, 'id' | 'createdAt' | 'updatedAt' | 'supersededBy' | 'accessCount' | 'lastAccessedAt'>): Promise<Memory> {
    const rows = await this.db.insert(memories).values(record).returning();
    return rows[0];
  }

  /**
   * Atomic UPDATE semantics: insert the new fact, then link the old
   * one's `superseded_by` pointer. Both in one transaction so a
   * partial failure can't leave the old row pointing at a missing
   * new id.
   */
  async supersede(
    oldId: string,
    newRecord: Omit<NewMemory, 'id' | 'createdAt' | 'updatedAt' | 'supersededBy' | 'accessCount' | 'lastAccessedAt'>,
  ): Promise<Memory> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.insert(memories).values(newRecord).returning();
      const newRow = inserted[0];
      await tx
        .update(memories)
        .set({ supersededBy: newRow.id, updatedAt: new Date() })
        .where(eq(memories.id, oldId));
      return newRow;
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(memories)
      .set({ validUntil: new Date(), updatedAt: new Date() })
      .where(eq(memories.id, id));
  }

  async getById(id: string): Promise<Memory | null> {
    const rows = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Validate a query vector before it reaches SQL. The driver parameterises
   * the literal, but a NaN from a calling-side bug should surface here rather
   * than as a confusing pgvector error several frames away.
   */
  private vectorLiteral(queryEmbedding: number[]): string | null {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return null;
    for (let i = 0; i < queryEmbedding.length; i++) {
      if (typeof queryEmbedding[i] !== 'number' || !Number.isFinite(queryEmbedding[i])) {
        throw new Error(`memories: queryEmbedding[${i}] is not a finite number`);
      }
    }
    return `[${queryEmbedding.join(',')}]`;
  }

  /** Rows visible to a scope: same user, live, and role/workspace-compatible. */
  private scopeConditions(scope: MemoryAccessScope) {
    const scopeFilter = scope.agentScope
      ? or(isNull(memories.agentScope), eq(memories.agentScope, scope.agentScope))
      : isNull(memories.agentScope);
    return [
      eq(memories.userId, scope.userId),
      isNull(memories.supersededBy),
      or(isNull(memories.validUntil), sql`${memories.validUntil} > now()`),
      scopeFilter,
      scope.workspaceId
        ? or(isNull(memories.workspaceId), eq(memories.workspaceId, scope.workspaceId))
        : undefined,
    ];
  }

  /**
   * Vector similarity top-k over active memories, scoped. The judge
   * uses this to decide whether a candidate fact updates an existing
   * memory — so the scope MUST match (same user, same fact_type,
   * compatible agent_scope) or the judge will silently dedupe across
   * unrelated facts.
   */
  async searchSimilar(
    queryEmbedding: number[],
    scope: MemoryAccessScope & { factType: string; limit?: number },
  ): Promise<Array<Memory & { similarity: number }>> {
    const limit = scope.limit ?? 5;
    const vecLiteral = this.vectorLiteral(queryEmbedding);
    if (vecLiteral === null) return [];
    // Parameterised — Drizzle binds `vecLiteral` as a placeholder and
    // pgvector casts it server-side. Earlier draft used sql.raw which
    // splices the literal directly; parameterising defeats the
    // splicing class of bug at the cost of one bind param.
    const similarity = sql<number>`1 - (${memories.embedding} <=> ${vecLiteral}::vector)`;
    const scopeFilter = scope.agentScope
      ? or(isNull(memories.agentScope), eq(memories.agentScope, scope.agentScope))
      : isNull(memories.agentScope);
    // Same workspace rule as retrieveTop: the judge must not supersede a
    // fact that belongs to another client's workspace.
    const workspaceScope = scope.workspaceId
      ? or(isNull(memories.workspaceId), eq(memories.workspaceId, scope.workspaceId))
      : undefined;

    const rows = await this.db
      .select({
        row: memories,
        similarity,
      })
      .from(memories)
      .where(
        and(
          eq(memories.userId, scope.userId),
          eq(memories.factType, scope.factType),
          isNull(memories.supersededBy),
          scopeFilter,
          workspaceScope,
        ),
      )
      .orderBy(desc(similarity))
      .limit(limit);

    return rows.map((r) => ({ ...r.row, similarity: Number(r.similarity) || 0 }));
  }

  /**
   * Turn-start relevance: top-k active memories nearest the TURN, across every
   * fact type.
   *
   * Distinct from `searchSimilar`, and the difference is the point.
   * `searchSimilar` answers the judge's question — "is this new fact an update
   * to an existing one?" — so it pins `fact_type` and ignores expiry, because
   * an expired row is still a row you can supersede. This answers the reader's
   * question — "what do I know that bears on what was just asked?" — where
   * pinning a fact type would be nonsense (nobody asks a question of one
   * fact_type) and returning an expired fact would be a lie.
   */
  async retrieveRelevant(
    queryEmbedding: number[],
    scope: MemoryAccessScope & { limit?: number },
  ): Promise<Array<Memory & { similarity: number }>> {
    const vecLiteral = this.vectorLiteral(queryEmbedding);
    if (vecLiteral === null) return [];
    const similarity = sql<number>`1 - (${memories.embedding} <=> ${vecLiteral}::vector)`;
    const rows = await this.db
      .select({ row: memories, similarity })
      .from(memories)
      .where(and(...this.scopeConditions(scope)))
      .orderBy(desc(similarity))
      .limit(scope.limit ?? 8);
    return rows.map((r) => ({ ...r.row, similarity: Number(r.similarity) || 0 }));
  }

  /**
   * Turn-start: retrieve top-N active memories scoped to
   * (user_id, agent_scope ∈ {NULL, currentRole}, workspace_id ∈ {NULL,
   * currentWorkspace}). A fact learned while working for one client must not
   * surface in another client's workspace. Ordered by
   * `access_count DESC, updated_at DESC` — frequently-recalled and
   * recently-changed facts surface first.
   *
   * This ordering is query-INDEPENDENT on purpose: it answers "what is always
   * worth knowing about this user", and it is the whole block while the corpus
   * still fits the token budget. Once it does not, `retrieveForContext` pairs
   * it with `retrieveRelevant` — see the note there for why one ordering alone
   * is not enough.
   */
  async retrieveTop(scope: MemoryAccessScope & { limit?: number }): Promise<Memory[]> {
    return this.db
      .select()
      .from(memories)
      .where(and(...this.scopeConditions(scope)))
      .orderBy(desc(memories.accessCount), desc(memories.updatedAt))
      .limit(scope.limit ?? 20);
  }

  recordAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const db = this.db;
    db
      .update(memories)
      .set({ accessCount: sql`${memories.accessCount} + 1`, lastAccessedAt: sql`now()` })
      .where(inArray(memories.id, ids))
      .catch((err) => coreLogger.warn({ err, count: ids.length }, 'memories.recordAccess failed (non-fatal)'));
  }
}

let _instance: MemoryRepository | null = null;
export function getMemoryRepository(): MemoryRepository {
  if (!_instance) _instance = new MemoryRepository();
  return _instance;
}
