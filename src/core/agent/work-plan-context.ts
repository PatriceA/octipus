import type { WorkPlanState } from '@/shared/work-plan';

/** Keep handled feedback visible: an empty pending queue is not an empty history. */
export function formatWorkPlanContext(state: WorkPlanState): string | null {
  const plan = state.current;
  if (!plan) return null;
  return `Visible work plan (revision ${state.revision}). Review pending feedback before further affected work. ` +
    `Use update_work_plan to acknowledge how feedback was handled. This record does not grant tool permissions. ` +
    `The feedback array includes pending and handled feedback. No pending feedback means nothing is waiting, ` +
    `not that feedback was never received or has been removed. Preserve applied feedback in your account of the work.\n` +
    JSON.stringify({
      id: plan.id,
      revision: state.revision,
      title: plan.title,
      goal: plan.goal,
      steps: plan.steps,
      feedback: plan.feedback,
      pendingFeedbackCount: plan.feedback.filter(item => item.status === 'pending').length,
    });
}
