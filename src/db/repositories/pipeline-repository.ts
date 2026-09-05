import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type NewPipelineCheckpoint,
  type PipelineCheckpointRow,
  pipelineCheckpoints,
} from '../schema/pipeline-checkpoints';
import {
  type NewPipeline,
  type NewPipelineEdge,
  type NewPipelineNode,
  type NewPlanItem,
  type Pipeline,
  type PipelineEdgeRow,
  type PipelineNodeRow,
  type PlanItemRow,
  pipelineEdges,
  pipelineNodes,
  pipelines,
  planItems,
} from '../schema/pipelines';

/**
 * Repository for a pipeline's graph — nodes, edges, and plan items. Execution
 * logic (the walker, retry routing, approval gates) lives in
 * `src/core/agent/pipeline-manager.ts`; that module goes through this
 * repository instead of touching `getDb()` directly so the data layer stays
 * swappable and conforms to the rest of the codebase.
 */
/** How many node-boundary snapshots one pipeline keeps. */
const CHECKPOINT_HISTORY = 50;

export class PipelineRepository {
  private get db() { return getDb(); }

  async create(data: NewPipeline): Promise<Pipeline> {
    const [row] = await this.db.insert(pipelines).values(data).returning();
    return row;
  }

  async createNodes(rows: NewPipelineNode[]): Promise<PipelineNodeRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(pipelineNodes).values(rows).returning();
  }

  async createEdges(rows: NewPipelineEdge[]): Promise<PipelineEdgeRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(pipelineEdges).values(rows).returning();
  }

  async findById(id: string): Promise<Pipeline | null> {
    const result = await this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async getNodes(pipelineId: string): Promise<PipelineNodeRow[]> {
    return this.db
      .select()
      .from(pipelineNodes)
      .where(eq(pipelineNodes.pipelineId, pipelineId))
      .orderBy(asc(pipelineNodes.ordinal));
  }

  async getEdges(pipelineId: string): Promise<PipelineEdgeRow[]> {
    return this.db
      .select()
      .from(pipelineEdges)
      .where(eq(pipelineEdges.pipelineId, pipelineId))
      .orderBy(asc(pipelineEdges.ordinal));
  }

  /** Bump an edge's traversal count. The walker's bound on every cycle. */
  async recordTraversal(
    pipelineId: string,
    from: string,
    to: string,
    condition: PipelineEdgeRow['condition'],
  ): Promise<void> {
    await this.db
      .update(pipelineEdges)
      .set({ traversals: sql`${pipelineEdges.traversals} + 1` })
      .where(
        and(
          eq(pipelineEdges.pipelineId, pipelineId),
          eq(pipelineEdges.fromNodeKey, from),
          eq(pipelineEdges.toNodeKey, to),
          eq(pipelineEdges.condition, condition),
        ),
      );
  }

  // ── Plan items ───────────────────────────────────────────────────

  /**
   * The plan, in iteration order. Read FRESH on every loop pass — an item
   * appended by a review or QA node mid-run must be picked up, which is the
   * whole reason the loop does not capture a list.
   */
  async getPlanItems(pipelineId: string): Promise<PlanItemRow[]> {
    return this.db
      .select()
      .from(planItems)
      .where(eq(planItems.pipelineId, pipelineId))
      .orderBy(asc(planItems.ordinal), asc(planItems.createdAt));
  }

  async addPlanItems(rows: NewPlanItem[]): Promise<PlanItemRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(planItems).values(rows).returning();
  }

  async updatePlanItem(id: string, data: Partial<NewPlanItem>): Promise<PlanItemRow | null> {
    const [row] = await this.db
      .update(planItems)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(planItems.id, id))
      .returning();
    return row ?? null;
  }

  async deletePlanItem(id: string): Promise<void> {
    await this.db.delete(planItems).where(eq(planItems.id, id));
  }

  // ── Checkpoints ──────────────────────────────────────────────────

  /**
   * Snapshot the walker at a node boundary, keeping only the newest
   * `CHECKPOINT_HISTORY` rows for the pipeline.
   *
   * ponytail: a fixed window rather than a retention policy. Each snapshot
   * carries the whole handoff chain, which grows as the walk proceeds, so an
   * unbounded history is quadratic in prose for a long plan loop. Rewinding
   * further back than the window is not offered; upgrade path if it is ever
   * wanted: store the chain by reference instead of by value.
   */
  async saveCheckpoint(row: NewPipelineCheckpoint): Promise<PipelineCheckpointRow> {
    const [saved] = await this.db.insert(pipelineCheckpoints).values(row).returning();
    // Pruned by COUNT, not by seq arithmetic: `seq` is global, so "newest minus
    // fifty" would mean "fifty rows written anywhere", which deletes a quiet
    // pipeline's whole history the moment a busy one runs alongside it.
    await this.db.execute(sql`
      DELETE FROM ${pipelineCheckpoints}
      WHERE ${pipelineCheckpoints.pipelineId} = ${row.pipelineId}
        AND ${pipelineCheckpoints.seq} < (
          SELECT MIN(seq) FROM (
            SELECT seq FROM ${pipelineCheckpoints}
            WHERE ${pipelineCheckpoints.pipelineId} = ${row.pipelineId}
            ORDER BY seq DESC LIMIT ${CHECKPOINT_HISTORY}
          ) keep
        )`);
    return saved;
  }

  /** Checkpoints newest-first — the shape the UI lists and `resume` picks from. */
  async getCheckpoints(pipelineId: string, limit = 100): Promise<PipelineCheckpointRow[]> {
    return this.db
      .select()
      .from(pipelineCheckpoints)
      .where(eq(pipelineCheckpoints.pipelineId, pipelineId))
      .orderBy(desc(pipelineCheckpoints.seq))
      .limit(limit);
  }

  /** One checkpoint, scoped to its pipeline so a foreign seq cannot resolve. */
  async getCheckpoint(pipelineId: string, seq: number): Promise<PipelineCheckpointRow | null> {
    const [row] = await this.db
      .select()
      .from(pipelineCheckpoints)
      .where(and(eq(pipelineCheckpoints.pipelineId, pipelineId), eq(pipelineCheckpoints.seq, seq)))
      .limit(1);
    return row ?? null;
  }

  async updateCheckpointState(
    pipelineId: string,
    seq: number,
    state: Record<string, unknown>,
  ): Promise<PipelineCheckpointRow | null> {
    const [row] = await this.db
      .update(pipelineCheckpoints)
      .set({ state })
      .where(and(eq(pipelineCheckpoints.pipelineId, pipelineId), eq(pipelineCheckpoints.seq, seq)))
      .returning();
    return row ?? null;
  }

  /**
   * Drop every checkpoint after `seq`. Rewinding makes them unreachable — the
   * walk that produced them is being replaced — and leaving them would offer
   * the user a future to resume into. The run log keeps the history.
   */
  async deleteCheckpointsAfter(pipelineId: string, seq: number): Promise<void> {
    await this.db
      .delete(pipelineCheckpoints)
      .where(and(eq(pipelineCheckpoints.pipelineId, pipelineId), gt(pipelineCheckpoints.seq, seq)));
  }

  /** Next ordinal for an appended item, so a late finding lands at the end. */
  async nextPlanOrdinal(pipelineId: string): Promise<number> {
    const rows = await this.getPlanItems(pipelineId);
    return rows.reduce((max, r) => Math.max(max, r.ordinal), -1) + 1;
  }
}

export const pipelineRepository = new PipelineRepository();
