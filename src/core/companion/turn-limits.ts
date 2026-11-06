import type { AgentContext } from '@/core/types';

/** Owner-driven chats inherit normal agent limits; unattended work stays bounded. */
export function companionControllerLimits(trigger: AgentContext['trigger'], backgroundBudget: number, reservedCap?: number) {
  return {
    maxTokenBudget: reservedCap ?? (trigger === 'user' ? undefined : backgroundBudget),
    maxIterations: trigger === 'user' ? undefined : 12,
  };
}
