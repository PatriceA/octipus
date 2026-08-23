import { and, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import {
  type NewSwarmNodeRecord,
  type SwarmChildResult,
  type SwarmNodeRecord,
  swarmNodes,
} from '@/db/schema/swarm-nodes';
import type { SwarmNodeStatus } from './types';

/**
 * Thin Drizzle repository for `swarm_nodes`. Keeps raw SQL out of the
 * spawner and keeps a single place for cache-lookup queries.
 */
export class SwarmNodeRepository {
  private get db() {
    return getDb();
  }

  async create(record: NewSwarmNodeRecord): Promise<SwarmNodeRecord> {
    const result = await this.db.insert(swarmNodes).values(record).returning();
    return result[0];
  }

  async findById(id: string): Promise<SwarmNodeRecord | null> {
    const result = await this.db
      .select()
      .from(swarmNodes)
      .where(eq(swarmNodes.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  /**
   * The DATABASE's clock, for callers that need to bracket a window against
   * `created_at`.
   *
   * `swarm_nodes.created_at` is `defaultNow()`, i.e. stamped by Postgres, so a
   * boundary taken with the app's `new Date()` compares two different clocks.
   * In a split-container or managed-Postgres deployment even a small negative
   * skew drops the children created in the window's first moments — a flaky
   * red for the very assertion the window exists to make honest. One trivial
   * round trip (no rows, no scan) removes the clock from the comparison.
   */
  async now(): Promise<Date> {
    // No table in the FROM clause on purpose: selecting from `swarm_nodes`
    // would return no row on an empty table and silently fall back to the app
    // clock — the exact skew this exists to remove, appearing only on a fresh
    // install where nobody would look for it.
    const res = await this.db.execute<{ at: string | Date }>(sql`select now() as at`);
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
      at: string | Date;
    }>;
    const at = rows[0]?.at;
    return at ? new Date(at) : new Date();
  }

  /**
   * Child nodes this session spawned at or after `since`, newest first.
   *
   * The turn-scoped read behind `routedRoles`. The caller used to bracket a
   * turn by taking the full node set before and after and diffing the ids,
   * which is two unbounded queries per chat turn — one of them awaited inside
   * the response literal, so it sat on the wire-time critical path of every
   * reply, on the very path whose delivery latency was the subject of a fix.
   * A timestamp costs nothing to take, so the boundary can be a predicate
   * rather than a set, and the row count no longer grows with the session.
   *
   * `depth > 0` because the root node is the orchestrator itself, which is not
   * a routing decision.
   */
  async findChildrenSince(rootSessionId: string, since: Date): Promise<SwarmNodeRecord[]> {
    return this.db
      .select()
      .from(swarmNodes)
      .where(
        and(
          eq(swarmNodes.rootSessionId, rootSessionId),
          gt(swarmNodes.depth, 0),
          gte(swarmNodes.createdAt, since),
        ),
      )
      .orderBy(desc(swarmNodes.createdAt))
      .limit(100);
  }

  async findByRootSession(rootSessionId: string): Promise<SwarmNodeRecord[]> {
    return this.db
      .select()
      .from(swarmNodes)
      .where(eq(swarmNodes.rootSessionId, rootSessionId))
      .orderBy(desc(swarmNodes.createdAt))
      .limit(500);
  }

  /**
   * Look up a cached `ok`-status node with matching brief hash in the same
   * root session. Returns the most-recent match.
   */
  async findCacheHit(
    rootSessionId: string,
    briefHash: string,
  ): Promise<SwarmNodeRecord | null> {
    const result = await this.db
      .select()
      .from(swarmNodes)
      .where(
        and(
          eq(swarmNodes.rootSessionId, rootSessionId),
          eq(swarmNodes.briefHash, briefHash),
          eq(swarmNodes.status, 'completed'),
        ),
      )
      .orderBy(desc(swarmNodes.completedAt))
      .limit(1);
    return result[0] ?? null;
  }

  async updateStatus(
    id: string,
    update: {
      status: SwarmNodeStatus;
      tokensUsed?: number;
      fanOutUsed?: number;
      result?: SwarmChildResult | null;
      error?: string;
    },
  ): Promise<void> {
    await this.db
      .update(swarmNodes)
      .set({
        status: update.status,
        tokensUsed: update.tokensUsed,
        fanOutUsed: update.fanOutUsed,
        result: update.result ?? undefined,
        error: update.error,
        completedAt: new Date(),
      })
      .where(eq(swarmNodes.id, id));
  }

  /**
   * Mark a node `cancelled` ONLY if it is still `running` — used by the
   * ledger resume to terminalize orphaned in-flight nodes without clobbering
   * a node that already reached a real terminal status. Returns true when a
   * row was flipped. Idempotent: a second call finds the row non-running.
   */
  async cancelIfRunning(id: string, error: string): Promise<boolean> {
    const rows = await this.db
      .update(swarmNodes)
      .set({ status: 'cancelled' as SwarmNodeStatus, error, completedAt: new Date() })
      .where(and(eq(swarmNodes.id, id), eq(swarmNodes.status, 'running')))
      .returning({ id: swarmNodes.id });
    return rows.length > 0;
  }

  /**
   * Flip `collected_at` when the parent agent picks up a detached child.
   * Distinguishes cleanly collected detached children from forgotten ones
   * (the orphan reaper finds rows where spawn_mode='detach' AND
   * collected_at IS NULL AND parent is already terminal).
   */
  async markCollected(id: string): Promise<void> {
    await this.db
      .update(swarmNodes)
      .set({ collectedAt: new Date() })
      .where(eq(swarmNodes.id, id));
  }

  async incrementCacheHits(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) return;
    await this.db
      .update(swarmNodes)
      .set({ cacheHits: existing.cacheHits + 1 })
      .where(eq(swarmNodes.id, id));
  }

  /**
   * Orphan reaper — the ids of `running` nodes older than `olderThanMs`. Does
   * NOT flip anything; the reaper decides per-candidate using worker liveness
   * (a stale `createdAt` alone can't tell a wedged worker from one legitimately
   * alive > the threshold — an orchestrator blocked on children), then flips
   * only the genuinely-stuck ones via `cancelNodes`.
   */
  async findRunningOlderThan(olderThanMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.db
      .select({ id: swarmNodes.id })
      .from(swarmNodes)
      .where(
        and(
          eq(swarmNodes.status, 'running'),
          lt(swarmNodes.createdAt, cutoff),
        ),
      );
    return rows.map((r) => r.id);
  }

  /**
   * Of these agent ids, which were the ROOT of their turn? A root is the depth-0
   * node, and `swarm_nodes.id` is 1:1 with `agents.id`, so this answers "is this
   * historical agent row Octipus itself" for callers that only have ids — the
   * `agents` table has no root column and the role name stopped identifying it
   * when the orchestrator role was deleted.
   */
  async findRootIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ id: swarmNodes.id })
      .from(swarmNodes)
      .where(and(inArray(swarmNodes.id, ids), eq(swarmNodes.depth, 0)));
    return new Set(rows.map((r) => r.id));
  }

  /** Flip a specific set of nodes to `cancelled` with the given error reason. */
  async cancelNodes(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(swarmNodes)
      .set({
        status: 'cancelled' as SwarmNodeStatus,
        error,
        completedAt: new Date(),
      })
      .where(inArray(swarmNodes.id, ids));
  }

  /**
   * Cancel detached subagents whose parent is in a terminal state and who
   * were never collected. Called by the orphan reaper. Returns the rows
   * touched — each identifies a case where an agent kicked off a detached
   * child and then finalized (or crashed) without collecting it.
   */
  async reapUncollectedDetached(): Promise<Array<{ id: string; parentNodeId: string | null }>> {
    // Two-step: find candidates, then update. Drizzle pg doesn't have a
    // clean "UPDATE ... WHERE EXISTS(..)" helper with the DSL we're using,
    // and the cardinality here is tiny so the extra select is fine.
    const parentTerminalStatuses: SwarmNodeStatus[] = [
      'completed', 'budget', 'timeout', 'denied', 'tool_error',
      'provider_error', 'cancelled', 'concurrency_limit', 'cache_hit',
    ];
    const candidates = await this.db
      .select({ id: swarmNodes.id, parentNodeId: swarmNodes.parentNodeId })
      .from(swarmNodes)
      .where(
        and(
          eq(swarmNodes.spawnMode, 'detach'),
          eq(swarmNodes.status, 'running' as SwarmNodeStatus),
        ),
      );
    const orphans: Array<{ id: string; parentNodeId: string | null }> = [];
    for (const c of candidates) {
      if (!c.parentNodeId) continue;
      const parent = await this.findById(c.parentNodeId);
      if (!parent) continue;
      if (!parentTerminalStatuses.includes(parent.status)) continue;
      orphans.push(c);
    }
    if (orphans.length === 0) return orphans;
    for (const o of orphans) {
      await this.db
        .update(swarmNodes)
        .set({
          status: 'cancelled' as SwarmNodeStatus,
          error: 'detached_parent_terminated_without_collect',
          completedAt: new Date(),
        })
        .where(eq(swarmNodes.id, o.id));
    }
    return orphans;
  }

  /**
   * Find all descendants of a given node (breadth-first). Used by admin
   * cancel to cascade the stop down the tree.
   */
  async findDescendants(nodeId: string): Promise<SwarmNodeRecord[]> {
    const collected: SwarmNodeRecord[] = [];
    const queue: string[] = [nodeId];
    const seen = new Set<string>([nodeId]);

    while (queue.length > 0) {
      const parent = queue.shift()!;
      const children = await this.db
        .select()
        .from(swarmNodes)
        .where(eq(swarmNodes.parentNodeId, parent));
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        collected.push(child);
        queue.push(child.id);
      }
    }
    return collected;
  }
}

export const swarmNodeRepository = new SwarmNodeRepository();
