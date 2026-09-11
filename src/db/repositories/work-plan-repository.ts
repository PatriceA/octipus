import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
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
    const [row] = await getDb().update(sessions).set({
      metadata: sql`jsonb_set(COALESCE(${sessions.metadata}, '{}'::jsonb), '{workPlan}', ${JSON.stringify(state)}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId),
      sql`COALESCE((${sessions.metadata}->'workPlan'->>'revision')::integer, 0) = ${expected}`,
    )).returning({ id: sessions.id });
    if (!row) throw new Error('Plan changed. Refresh and try again.');
  },
};
