import type { WorkPlanState } from '@/shared/work-plan';

export function planLearningTrigger(before: WorkPlanState, after: WorkPlanState) {
  const plan = after.current;
  if (!plan || plan.kind !== 'execution') return null;
  const previous = before.current?.id === plan.id && before.current.kind === 'execution' ? before.current : null;
  // Only a finished plan is a milestone. A review per completed step cost a
  // model call per step; the work between is covered by the tool-call counter.
  const complete = plan.steps.every(step => step.status === 'done' || step.status === 'skipped');
  const wasComplete = previous?.steps.every(step => step.status === 'done' || step.status === 'skipped');
  if (!complete || wasComplete || !plan.steps.some(step => step.status === 'done')) return null;
  return {
    trigger: 'plan_completed' as const,
    triggerKey: `plan:${plan.id}:${after.revision}`,
    title: `Learning check: ${plan.title}`,
    plan: { id: plan.id, title: plan.title, goal: plan.goal, steps: plan.steps },
  };
}

/** Enough tool calls since the last review (hermes's skill nudge counts iterations the same way). */
export function reviewDue(toolCallsSinceReview: number, every: number): boolean {
  return toolCallsSinceReview >= every;
}
