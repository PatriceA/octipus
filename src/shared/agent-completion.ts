/** Why a normally finalized run stopped, independent of the model's prose. */
export type AgentCompletionReason = 'iteration_limit' | 'time_limit';

export function readAgentCompletionReason(metadata: unknown): AgentCompletionReason | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const reason = (metadata as Record<string, unknown>).completionReason;
  return reason === 'iteration_limit' || reason === 'time_limit' ? reason : undefined;
}

export function agentCompletionLabel(reason: unknown): string | undefined {
  if (reason === 'iteration_limit') return 'Stopped at turn limit';
  if (reason === 'time_limit') return 'Stopped at time limit';
  return undefined;
}
