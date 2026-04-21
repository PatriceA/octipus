import { and, desc, eq, lt } from 'drizzle-orm';
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

  async incrementCacheHits(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) return;
    await this.db
      .update(swarmNodes)
      .set({ cacheHits: existing.cacheHits + 1 })
      .where(eq(swarmNodes.id, id));
  }

  /**
   * Orphan reaper — mark any `running` node older than `olderThanMs` as
   * `cancelled` with `error='orphaned_at_restart'`. Returns number of rows
   * updated.
   *
   * Runs on process boot; catches rows left stale when the server was
   * killed mid-swarm. Mirrors `agent-manager.ts` stale-agent cleanup but
   * targets the sibling `swarm_nodes` table.
   */
  async reapOrphans(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.db
      .update(swarmNodes)
      .set({
        status: 'cancelled' as SwarmNodeStatus,
        error: 'orphaned_at_restart',
        completedAt: new Date(),
      })
      .where(
        and(
          eq(swarmNodes.status, 'running'),
          lt(swarmNodes.createdAt, cutoff),
        ),
      )
      .returning({ id: swarmNodes.id });
    return rows.length;
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
