import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
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
 * `src/core/orchestrator/pipeline-manager.ts`; that module goes through this
 * repository instead of touching `getDb()` directly so the data layer stays
 * swappable and conforms to the rest of the codebase.
 */
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

  /** Next ordinal for an appended item, so a late finding lands at the end. */
  async nextPlanOrdinal(pipelineId: string): Promise<number> {
    const rows = await this.getPlanItems(pipelineId);
    return rows.reduce((max, r) => Math.max(max, r.ordinal), -1) + 1;
  }
}

export const pipelineRepository = new PipelineRepository();
