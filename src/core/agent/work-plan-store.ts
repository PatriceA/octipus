/**
 * Saving a session's work plan, and telling the user's clients it changed.
 *
 * Every write of a plan — the agent's `update_work_plan` / `exit_plan_mode`,
 * `/plan-feedback`, the web's feedback route — goes through `saveWorkPlan`,
 * which publishes `session.plan_updated` (the session's id on the envelope,
 * the new revision in the payload) to the plan owner's connections once the
 * row is written. Clients refresh their plan summary on it instead of
 * polling for it.
 *
 * The save is the operation; the event only tells. If publishing fails the
 * plan is still saved, so the error is logged rather than thrown — a client
 * that missed it sees the plan on its next fetch (connect, `/work-plan`).
 */
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import type { WorkPlanState } from '@/shared/work-plan';
import { coreLogger } from '@/utils/logger';

export async function saveWorkPlan(sessionId: string, userId: string, expected: number, state: WorkPlanState): Promise<void> {
  await workPlanRepository.save(sessionId, userId, expected, state);
  try {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    getGatewayHub().publishEvent({
      type: 'session.plan_updated',
      source: 'work-plan',
      userId,
      sessionId,
      payload: { revision: state.revision },
    });
  } catch (err) {
    coreLogger.error({ err, sessionId }, 'Work plan saved, but session.plan_updated could not be published');
  }
}
