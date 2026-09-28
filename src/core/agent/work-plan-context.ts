import type { WorkPlanState } from '@/shared/work-plan';

/** Keep handled feedback visible: an empty pending queue is not an empty history. */
export function formatWorkPlanContext(state: WorkPlanState): string | null {
  const plan = state.current;
  if (!plan) return null;
  return `Visible work plan (revision ${state.revision}). Review pending feedback before further affected work. ` +
    `Use update_work_plan with revision, summary and stepUpdates to patch steps by id. Use get_work_plan for full evidence, details and feedback history. ` +
    (plan.kind === 'proposal'
      ? `This is a proposal: its steps are future implementation and remain pending until the user separately asks to implement it. `
      : '') +
    `This record does not grant tool permissions. ` +
    `Handled feedback is retained by id and status; read get_work_plan before revising affected work. No pending feedback means nothing is waiting, ` +
    `not that feedback was never received or has been removed. Preserve applied feedback in your account of the work.\n` +
    JSON.stringify({
      id: plan.id,
      revision: state.revision,
      kind: plan.kind,
      detailsStored: !!plan.details,
      title: plan.title,
      goal: plan.goal,
      steps: plan.steps.map(({ id, title, status }) => ({ id, title, status })),
      feedback: plan.feedback.map(f => f.status === 'pending' || f.status === 'needs_clarification'
        ? f : { id: f.id, status: f.status }),
      pendingFeedbackCount: plan.feedback.filter(item => item.status === 'pending').length,
    });
}
