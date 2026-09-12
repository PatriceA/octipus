import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentContext } from './types';

// Runtime cancellation stays out of serialized agent context and model arguments.
const executions = new AsyncLocalStorage<{ agentId: string; signal?: AbortSignal }>();

export function withExecutionSignal<T>(context: AgentContext, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return executions.run({ agentId: context.id, signal }, run);
}

export function getExecutionSignal(context: AgentContext): AbortSignal | undefined {
  const execution = executions.getStore();
  return execution?.agentId === context.id ? execution.signal : undefined;
}

export function assertExecutionActive(context: AgentContext): void {
  if (getExecutionSignal(context)?.aborted || context.status === 'stopped' || context.status === 'failed') {
    throw new Error('Agent stopped before tool execution');
  }
}
