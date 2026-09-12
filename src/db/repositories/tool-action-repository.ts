import { and, eq, inArray, isNull } from 'drizzle-orm';
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
  async acknowledge(userId: string, sessionId: string, ids: string[], reviewId: string): Promise<void> {
    if (!ids.length) return;
    await getDb().update(toolActions).set({ reviewedAt: new Date(), reviewId })
      .where(and(eq(toolActions.userId, userId), eq(toolActions.sessionId, sessionId), inArray(toolActions.id, ids)));
  }
}
export type ToolActionScope = Pick<ToolAction, 'id' | 'userId' | 'sessionId'>;
export const toolActionRepository = new ToolActionRepository();
