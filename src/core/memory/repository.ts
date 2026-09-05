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
 *                       across the visible scopes. The retrieval
 *                       module is what callers actually invoke;
 *                       this is its data primitive.
 *   - `recordAccess`  — fire-and-forget bump of access_count +
 *                       last_accessed_at. Same shape as the
 *                       EmbeddingService LFU signal.
 */

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type Memory, type NewMemory, memories } from '@/db/schema/memories';
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
    // Validate the vector before letting it touch SQL. The driver
    // parameterises the literal below, but we still refuse non-finite
    // entries early so a NaN can't escape a calling-side bug into a
    // confusing pgvector error.
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return [];
    }
    for (let i = 0; i < queryEmbedding.length; i++) {
      if (typeof queryEmbedding[i] !== 'number' || !Number.isFinite(queryEmbedding[i])) {
        throw new Error(`memories.searchSimilar: queryEmbedding[${i}] is not a finite number`);
      }
    }
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
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
   * Turn-start: retrieve top-N active memories scoped to
   * (user_id, agent_scope ∈ {NULL, currentRole}, workspace_id ∈ {NULL,
   * currentWorkspace}). A fact learned while working for one client must not
   * surface in another client's workspace. Ordered by
   * `access_count DESC, updated_at DESC` — frequently-recalled and
   * recently-changed facts surface first. Vector ranking is the
   * judge's job; for plain recall, recency + frequency are the
   * cheapest signals that actually correlate with usefulness.
   */
  async retrieveTop(scope: MemoryAccessScope & { limit?: number }): Promise<Memory[]> {
    const limit = scope.limit ?? 20;
    const scopeFilter = scope.agentScope
      ? or(isNull(memories.agentScope), eq(memories.agentScope, scope.agentScope))
      : isNull(memories.agentScope);
    const workspaceScope = scope.workspaceId
      ? or(isNull(memories.workspaceId), eq(memories.workspaceId, scope.workspaceId))
      : undefined;
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, scope.userId),
          isNull(memories.supersededBy),
          // Skip expired memories.
          or(
            isNull(memories.validUntil),
            sql`${memories.validUntil} > now()`,
          ),
          scopeFilter,
          workspaceScope,
        ),
      )
      .orderBy(desc(memories.accessCount), desc(memories.updatedAt))
      .limit(limit);
    return rows;
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
