import type { PipelineReplayScope } from '@/shared/pipeline-replay';
import { pipelineCheckpoints } from '../schema/pipeline-checkpoints';
import { permissionRequests } from '../schema/permissions';
import { acknowledgeRecoveryApproval, recoveryActionIds } from './recovery-consent';
import { and, eq, inArray, isNull, sql, desc } from 'drizzle-orm';
import { getDb } from '../postgres';
import { toolActions, type ToolAction } from '../schema/tool-actions';

export class ToolActionRepository {
  async start(row: typeof toolActions.$inferInsert): Promise<void> {
    await getDb().insert(toolActions).values(row);
  }
  async finish(row: ToolActionScope, status: ToolAction['status']): Promise<void> {
    const updated = await getDb().update(toolActions).set({ status, finishedAt: new Date() })
      .where(and(eq(toolActions.id, row.id), eq(toolActions.userId, row.userId), eq(toolActions.sessionId, row.sessionId)))
      .returning({ id: toolActions.id });
    if (!updated.length) throw new Error('Tool action record disappeared');
  }
  async pending(userId: string, sessionId: string): Promise<ToolAction[]> {
    return getDb().select().from(toolActions).where(and(eq(toolActions.userId, userId),
      eq(toolActions.sessionId, sessionId), isNull(toolActions.reviewedAt), inArray(toolActions.status, ['started', 'uncertain'])));
  }
  async pipeline(userId: string, sessionId: string, pipelineId: string): Promise<ToolAction[]> {
    return getDb().select().from(toolActions).where(and(eq(toolActions.userId, userId), eq(toolActions.sessionId, sessionId),
      eq(toolActions.pipelineId, pipelineId), isNull(toolActions.reviewedAt), inArray(toolActions.status, ['started', 'uncertain', 'completed'])));
  }
  /** Recover approvals whose original worker/waiter disappeared after the human answered. */
  async reconcileApproved(userId: string, sessionId: string, pendingIds: string[]): Promise<number> {
    if (!pendingIds.length) return 0;
    const pending = new Set(pendingIds);
    return getDb().transaction(async tx => {
      const requests = await tx.select().from(permissionRequests).where(and(eq(permissionRequests.userId, userId),
        eq(permissionRequests.sessionId, sessionId), eq(permissionRequests.toolId, 'action_recovery'), eq(permissionRequests.status, 'approved')))
        .orderBy(permissionRequests.resolvedAt);
      let reviewed = 0;
      for (const request of requests) if (recoveryActionIds(request).some(id => pending.has(id))) {
        reviewed += await acknowledgeRecoveryApproval(request, tx);
      }
      return reviewed;
    });
  }
  async findReplayApproval(userId: string, sessionId: string, workspaceId: string | null, scope: PipelineReplayScope): Promise<string | undefined> {
    const [head] = await getDb().select({ seq: pipelineCheckpoints.seq }).from(pipelineCheckpoints)
      .where(eq(pipelineCheckpoints.pipelineId, scope.pipelineId)).orderBy(desc(pipelineCheckpoints.seq)).limit(1);
    if (head?.seq !== scope.headSeq) return undefined;
    const [request] = await getDb().select({ id: permissionRequests.id }).from(permissionRequests).where(and(
      eq(permissionRequests.userId, userId), eq(permissionRequests.sessionId, sessionId),
      workspaceId === null ? isNull(permissionRequests.workspaceId) : eq(permissionRequests.workspaceId, workspaceId),
      eq(permissionRequests.toolId, 'action_recovery'), eq(permissionRequests.action, 'replay_pipeline'), eq(permissionRequests.status, 'approved'),
      sql`${permissionRequests.context}->'toolArguments'->'replayScope' = ${JSON.stringify(scope)}::jsonb`,
      sql`${permissionRequests.context}->'toolArguments'->>'replayConsumedByCheckpoint' IS NULL`,
    )).orderBy(desc(permissionRequests.resolvedAt)).limit(1);
    return request?.id;
  }
  async acknowledge(userId: string, sessionId: string, ids: string[], reviewId: string): Promise<void> {
    if (!ids.length) return;
    await getDb().update(toolActions).set({ reviewedAt: new Date(), reviewId })
      .where(and(eq(toolActions.userId, userId), eq(toolActions.sessionId, sessionId), inArray(toolActions.id, ids)));
  }
}
export type ToolActionScope = Pick<ToolAction, 'id' | 'userId' | 'sessionId'>;
export const toolActionRepository = new ToolActionRepository();
