import { assertNoCredentialTemplates } from '@/security/credential-boundary';
import type { PendingStageApproval } from '@/shared/pipeline-approval';
import { sessions } from '../schema/sessions';
import { emptyWorkPlan, workPlanStateSchema } from '@/shared/work-plan';
import { projectPipelinePlan } from './pipeline-work-plan';
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { runEvents } from '../schema/run-events';
import type { PipelineItemEdit, PipelineUserDecision } from '@/shared/pipeline-items';
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
    assertNoCredentialTemplates(data);
    const [row] = await this.db.insert(pipelines).values(data).returning();
    return row;
  }

  /** Append an audited run record without replacing concurrent approvals, budget or plan edits. */
  async appendRunMetadata(id: string, key: 'deniedRequests' | 'approvedCalls', entry: Record<string, unknown>): Promise<void> {
    await this.db.update(pipelines).set({ metadata: sql`jsonb_set(COALESCE(${pipelines.metadata}, '{}'::jsonb),
      ARRAY[${key}], COALESCE(${pipelines.metadata}->${key}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb)`, updatedAt: new Date() })
      .where(eq(pipelines.id, id));
  }

  /** Publish one actionable request with its waiting state; cancellation cannot be overwritten. */
  async publishApproval(id: string, pending: PendingStageApproval, summary: string): Promise<boolean> {
    return this.db.transaction(async tx => {
      const rows = await tx.update(pipelines).set({ status: 'awaiting_approval', summary, updatedAt: new Date(),
        metadata: sql`jsonb_set(COALESCE(${pipelines.metadata}, '{}'::jsonb), '{pendingApproval}', ${JSON.stringify(pending)}::jsonb)`,
      }).where(and(eq(pipelines.id, id), notInArray(pipelines.status, ['stopped', 'completed', 'failed'])))
        .returning({ id: pipelines.id });
      if (rows.length) await this.syncWorkPlan(tx, id);
      return rows.length > 0;
    });
  }

  /** Keep the visible plan in step with failures and resumed execution too. */
  async updatePipeline(id: string, data: Partial<NewPipeline>): Promise<void> {
    assertNoCredentialTemplates(data);
    await this.db.transaction(async tx => {
      await tx.update(pipelines).set({ ...data,
        // A stage may have read metadata before a root queued plan edits.
        // Only applyItemEdits consumes that queue, under the same row lock.
        ...(data.metadata ? { metadata: sql`(${JSON.stringify(data.metadata)}::jsonb - 'pendingItemEdits') ||
          CASE WHEN ${pipelines.metadata} ? 'pendingItemEdits'
          THEN jsonb_build_object('pendingItemEdits', ${pipelines.metadata}->'pendingItemEdits') ELSE '{}'::jsonb END` } : {}),
        updatedAt: new Date() }).where(eq(pipelines.id, id));
      if (data.metadata?.environmentBlock) await this.clearSettledEnvironmentBlock(tx, id);
      await this.syncWorkPlan(tx, id);
    });
  }

  /** Commit the answer without completing the item used to route the question. */
  async settleUserDecision(pipelineId: string, decision: PipelineUserDecision): Promise<boolean> {
    return this.db.transaction(async tx => {
      // i2: the runtime supplies its authorized pipeline id; the decision item is constrained to the same pipeline.
      const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, pipelineId)).for('update');
      if (!pipeline || !['running', 'awaiting_approval'].includes(pipeline.status)) return false;
      const pending = pipeline.metadata?.pendingDecision as Partial<PipelineUserDecision> | undefined;
      if (pending?.itemId !== decision.itemId || pending.blockedItemId !== decision.blockedItemId
        || pending.nodeKey !== decision.nodeKey || pending.attemptId !== decision.attemptId) return false;
      const [item] = await tx.select().from(planItems).where(and(eq(planItems.id, decision.itemId), eq(planItems.pipelineId, pipelineId)));
      if (!item || ['done', 'skipped'].includes(item.status)) return false;
      // The reference routes the question; only the execution loop may complete work.
      const { pendingDecision: _settled, ...metadata } = pipeline.metadata ?? {};
      await tx.update(pipelines).set({ status: 'running', summary: 'User decision recorded; continuing the saved stage.', updatedAt: new Date(),
        metadata: { ...metadata, userDecisions: [...(Array.isArray(metadata.userDecisions) ? metadata.userDecisions : []), decision] },
      }).where(eq(pipelines.id, pipelineId));
      await this.clearSettledEnvironmentBlock(tx, pipelineId);
      await this.syncWorkPlan(tx, pipelineId);
      return true;
    });
  }

  private async clearSettledEnvironmentBlock(tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0], pipelineId: string): Promise<void> {
    // i2: both the outer pipeline and its settled item are constrained to this authorized pipeline id.
    const settled = sql`EXISTS (SELECT 1 FROM ${planItems} WHERE ${planItems.pipelineId} = ${pipelines.id}
      AND ${planItems.id}::text = ${pipelines.metadata}->'environmentBlock'->>'itemId' AND ${planItems.status} IN ('done', 'skipped'))`;
    await tx.update(pipelines).set({ metadata: sql`${pipelines.metadata} - 'environmentBlock'` })
      .where(and(eq(pipelines.id, pipelineId), sql`${pipelines.metadata} ? 'environmentBlock'`, settled));
  }

  async dueDeferred(now: Date): Promise<Pipeline[]> {
    // i2: server-only wake sweep, never returned to a caller; resume rechecks each owner's session and space membership before dispatch.
    return this.db.select().from(pipelines).where(and(eq(pipelines.status, 'paused'),
      sql`${pipelines.metadata}->>'resumeAfter' IS NOT NULL`,
      sql`${pipelines.metadata}->>'resumeAfter' <= ${now.toISOString()}`,
      sql`NOT (${pipelines.metadata} ? 'deferredWakeError')`)).limit(50);
  }

  async createNodes(rows: NewPipelineNode[]): Promise<PipelineNodeRow[]> {
    assertNoCredentialTemplates(rows);
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
      // i2: pipeline run state by pipeline id, for the pipeline runtime
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

  async getStageHistory(pipelineId: string, sessionId?: string) {
    return this.db.select().from(runEvents).where(and(eq(runEvents.subject, 'pipeline_node'),
      sessionId ? eq(runEvents.runId, sessionId) : undefined,
      sql`${runEvents.payload}->>'pipelineId' = ${pipelineId}`)).orderBy(asc(runEvents.seq));
  }

  /** Queue session-owned edits; the walker applies the whole batch at an item boundary. */
  async queueItemEdit(pipelineId: string, edit: PipelineItemEdit): Promise<void> {
    await this.db.transaction(async tx => {
      // i2: caller authorizes the pipeline's owner/session/workspace before queueing edits
      const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, pipelineId)).for('update');
      if (!pipeline || pipeline.status === 'completed') throw new Error('Pipeline is not active; resume it before editing items');
      const items = await tx.select().from(planItems).where(eq(planItems.pipelineId, pipelineId));
      for (const id of [...edit.skip, ...(edit.reopen ?? []), ...(edit.update ?? []).map(item => item.id), ...(edit.order ?? [])]) {
        if (!items.some(item => item.id === id)) throw new Error(`Unknown pipeline item: ${id}`);
      }
      for (const item of edit.add) if (item.beforeItemId && !items.some(existing => existing.id === item.beforeItemId)) throw new Error(`Unknown insertion target: ${item.beforeItemId}`);
      if (new Set(edit.order).size !== (edit.order?.length ?? 0)) throw new Error('order contains duplicate item ids');
      if (!['paused', 'stopped', 'failed'].includes(pipeline.status) && [...edit.skip, ...(edit.reopen ?? []), ...(edit.update ?? []).map(item => item.id)].some(id => items.some(item => item.id === id && item.status === 'running'))) throw new Error('Cannot edit the active item; stop the pipeline first');
      const edits = (pipeline.metadata?.pendingItemEdits ?? []) as PipelineItemEdit[];
      if (edits.length >= 20) throw new Error('Too many pending item edits; wait for the next item boundary');
      await tx.update(pipelines).set({ metadata: { ...pipeline.metadata, pendingItemEdits: [...edits, edit] }, updatedAt: new Date() }).where(eq(pipelines.id, pipelineId));
      await this.syncWorkPlan(tx, pipelineId);
    });
  }

  async applyItemEdits(pipelineId: string): Promise<void> {
    await this.db.transaction(async tx => {
      // i2: the authorized pipeline walker consumes its own queued plan edits
      const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, pipelineId)).for('update');
      const edits = (pipeline?.metadata?.pendingItemEdits ?? []) as PipelineItemEdit[];
      if (!edits.length) return;
      let items = await tx.select().from(planItems).where(eq(planItems.pipelineId, pipelineId)).orderBy(asc(planItems.ordinal));
      for (const edit of edits) {
        for (const id of edit.skip) await tx.update(planItems).set({ status: 'skipped', result: edit.evidence, updatedAt: new Date() })
          .where(and(eq(planItems.pipelineId, pipelineId), eq(planItems.id, id), inArray(planItems.status, ['pending', 'running', 'failed'])));
        for (const id of edit.reopen ?? []) await tx.update(planItems).set({ status: 'pending', error: null, completedAt: null, updatedAt: new Date() })
          .where(and(eq(planItems.pipelineId, pipelineId), eq(planItems.id, id)));
        for (const { id, ...patch } of edit.update ?? []) await tx.update(planItems).set({ ...patch, updatedAt: new Date() })
          .where(and(eq(planItems.pipelineId, pipelineId), eq(planItems.id, id)));
        if (edit.order) items = [...edit.order.map(id => items.find(item => item.id === id)!), ...items.filter(item => !edit.order!.includes(item.id))];
        for (const { beforeItemId, ...item } of edit.add) {
          const position = beforeItemId ? items.findIndex(existing => existing.id === beforeItemId) : items.length;
          if (position < 0) throw new Error(`Unknown insertion target: ${beforeItemId}`);
          const [created] = await tx.insert(planItems).values({ ...item, pipelineId, ordinal: items.length, detail: item.detail ?? edit.evidence }).returning();
          items.splice(position, 0, created);
        }
      }
      for (const [index, item] of items.entries()) await tx.update(planItems).set({ ordinal: index }).where(eq(planItems.id, item.id));
      const { pendingItemEdits: _applied, ...metadata } = pipeline.metadata ?? {};
      if (edits.some(edit => [...(edit.reopen ?? []), ...(edit.update ?? []).map(item => item.id), ...edit.skip].includes(String(metadata.deferredItemId)))) {
        delete metadata.resumeAfter; delete metadata.deferredItemId; delete metadata.deferredReason; delete metadata.deferredWakeError;
      }
      metadata.itemEditHistory = [...(Array.isArray(metadata.itemEditHistory) ? metadata.itemEditHistory : []), ...edits.map(edit => ({ ...edit, appliedAt: new Date().toISOString() }))];
      await tx.update(pipelines).set({ metadata, updatedAt: new Date() }).where(eq(pipelines.id, pipelineId));
      if (edits.some(edit => edit.skip.length)) await this.clearSettledEnvironmentBlock(tx, pipelineId);
      await this.syncWorkPlan(tx, pipelineId);
    });
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

  async addPlanItems(rows: NewPlanItem[], beforeItemId?: string): Promise<PlanItemRow[]> {
    assertNoCredentialTemplates(rows);
    if (rows.length === 0) return [];
    return this.db.transaction(async tx => {
      if (beforeItemId) {
        const pipelineId = rows[0].pipelineId;
        if (rows.some(row => row.pipelineId !== pipelineId)) throw new Error('Priority insertion must belong to one pipeline');
        // i2: stage metadata or the root recovery tool authorizes this pipeline; every row and insertion target is scoped to that id.
        await tx.select().from(pipelines).where(eq(pipelines.id, pipelineId)).for('update');
        const existing = await tx.select().from(planItems).where(eq(planItems.pipelineId, pipelineId)).orderBy(asc(planItems.ordinal));
        const index = existing.findIndex(item => item.id === beforeItemId);
        if (index < 0) throw new Error(`Unknown insertion target: ${beforeItemId}`);
        const created = await tx.insert(planItems).values(rows).returning();
        existing.splice(index, 0, ...created);
        for (const [ordinal, item] of existing.entries()) await tx.update(planItems).set({ ordinal }).where(eq(planItems.id, item.id));
        await this.syncWorkPlan(tx, pipelineId);
        return created.map(item => ({ ...item, ordinal: existing.findIndex(candidate => candidate.id === item.id) }));
      }
      const created = await tx.insert(planItems).values(rows).returning();
      for (const id of [...new Set(rows.map(row => row.pipelineId))].sort()) await this.syncWorkPlan(tx, id);
      return created;
    });
  }

  async updatePlanItem(id: string, data: Partial<NewPlanItem>): Promise<PlanItemRow | null> {
    assertNoCredentialTemplates(data);
    return this.db.transaction(async tx => {
      const [row] = await tx.update(planItems).set({ ...data, updatedAt: new Date() })
        .where(eq(planItems.id, id)).returning();
      if (row) {
        if (['done', 'skipped'].includes(row.status)) await this.clearSettledEnvironmentBlock(tx, row.pipelineId);
        await this.syncWorkPlan(tx, row.pipelineId);
      }
      return row ?? null;
    });
  }

  private async syncWorkPlan(tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0], pipelineId: string): Promise<void> {
    // i2: pipeline run state by pipeline id, for the pipeline runtime
    const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, pipelineId));
    if (!pipeline) return;
    // i2: pipeline run state by pipeline id, for the pipeline runtime
    const [session] = await tx.select().from(sessions)
      .where(and(eq(sessions.id, pipeline.sessionId), eq(sessions.userId, pipeline.userId))).for('update');
    if (!session || session.context?.planMode) return;
    const state = session.metadata?.workPlan === undefined ? emptyWorkPlan() : workPlanStateSchema.parse(session.metadata.workPlan);
    const items = await tx.select().from(planItems).where(eq(planItems.pipelineId, pipelineId))
      .orderBy(asc(planItems.ordinal), asc(planItems.createdAt));
    const previousId = state.current?.sourcePipelineId;
    const [previousPipeline] = previousId && previousId !== pipelineId
      // i2: pipeline run state by pipeline id, for the pipeline runtime
      ? await tx.select().from(pipelines).where(and(eq(pipelines.id, previousId), eq(pipelines.sessionId, pipeline.sessionId)))
      : [];
    const next = projectPipelinePlan(state, pipeline, items, previousPipeline);
    if (next === state) return;
    await tx.update(sessions).set({
      metadata: sql`jsonb_set(COALESCE(${sessions.metadata}, '{}'::jsonb), '{workPlan}', ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(sessions.id, pipeline.sessionId));
  }

  async deletePlanItem(id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const [removed] = await tx.delete(planItems).where(eq(planItems.id, id)).returning();
      if (removed) await this.syncWorkPlan(tx, removed.pipelineId);
    });
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
