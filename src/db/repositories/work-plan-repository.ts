import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { backgroundJobs } from '../schema/background-jobs';
import { planLearningTrigger } from '@/core/learning/triggers';
import { sessions } from '../schema/sessions';
import { emptyWorkPlan, workPlanStateSchema, type WorkPlanState } from '@/shared/work-plan';

/** Persist plans independently of session context, with optimistic concurrency. */
export const workPlanRepository = {
  async read(sessionId: string, userId: string): Promise<WorkPlanState> {
    const [row] = await getDb().select({ metadata: sessions.metadata }).from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).limit(1);
    if (!row) throw new Error('Session not found');
    return row.metadata?.workPlan === undefined ? emptyWorkPlan() : workPlanStateSchema.parse(row.metadata.workPlan);
  },
  async save(sessionId: string, userId: string, expected: number, state: WorkPlanState): Promise<void> {
    await getDb().transaction(async tx => {
      const [old] = await tx.select({ metadata: sessions.metadata, workspaceId: sessions.workspaceId }).from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).for('update');
      if (!old) throw new Error('Session not found');
      const before = old.metadata?.workPlan === undefined ? emptyWorkPlan() : workPlanStateSchema.parse(old.metadata.workPlan);
      if (before.revision !== expected) throw new Error('Plan changed. Refresh and try again.');
      await tx.update(sessions).set({
        metadata: sql`jsonb_set(COALESCE(${sessions.metadata}, '{}'::jsonb), '{workPlan}', ${JSON.stringify(state)}::jsonb)`,
        updatedAt: new Date(),
      }).where(eq(sessions.id, sessionId));
      const trigger = planLearningTrigger(before, state);
      if (trigger) await tx.insert(backgroundJobs).values({
        kind: 'learning', userId, workspaceId: old.workspaceId,
        title: trigger.title, payload: { sessionId, ...trigger, through: new Date().toISOString() },
      });
    });
  },
};
