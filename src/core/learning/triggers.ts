import type { WorkPlanState } from '@/shared/work-plan';

export function planLearningTrigger(before: WorkPlanState, after: WorkPlanState) {
  const plan = after.current;
  if (!plan || plan.kind !== 'execution') return null;
  const previous = before.current?.id === plan.id && before.current.kind === 'execution' ? before.current : null;
  const completed = plan.steps.filter(step => step.status === 'done' && previous?.steps.find(old => old.id === step.id)?.status !== 'done');
  const complete = plan.steps.every(step => step.status === 'done' || step.status === 'skipped');
  const wasComplete = previous?.steps.every(step => step.status === 'done' || step.status === 'skipped');
  if (!completed.length && !(complete && !wasComplete && plan.steps.some(step => step.status === 'done'))) return null;
  return {
    trigger: complete ? 'plan_completed' : 'steps_completed',
    triggerKey: `plan:${plan.id}:${after.revision}`,
    title: `Learning check: ${plan.title}`,
    plan: { id: plan.id, title: plan.title, goal: plan.goal,
      steps: complete ? plan.steps : completed },
  };
}

export function isSubstantialTurn(toolEvents: number, durationMs: number): boolean {
  return toolEvents >= 6 || (toolEvents > 0 && durationMs >= 120_000);
}
