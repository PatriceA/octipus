import type { AgentContext } from '@/core/types';

/** Owner-driven chats inherit normal agent limits; unattended work stays bounded. */
export function companionControllerLimits(trigger: AgentContext['trigger'], backgroundBudget: number, reservedCap?: number) {
  return {
    maxTokenBudget: reservedCap ?? (trigger === 'user' ? undefined : backgroundBudget),
    maxIterations: trigger === 'user' ? undefined : 12,
  };
}

/** A controller cap is an execution limit, never an owner stop. */
export function companionBudgetResponse(error: unknown, trigger: AgentContext['trigger']): string | null {
  if (!(error instanceof Error) || error.name !== 'BudgetExceededError') return null;
  if(trigger==='user')return `Companion reached the normal agent token budget. ${error.message}. Direct chats use the normal agent limit, configured separately from Background supervision. Project sessions and pipelines retain their own budgets.`;
  return `Companion reached its background turn token budget. ${error.message}. Open Companion → Background supervision → Resource limits to adjust it. Project sessions and pipelines retain their own budgets.`;
}
