import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { AgentContext } from '@/core/types';

interface Authorization {
  userId: string;
  sessionId: string;
  agentId: string;
  toolId: string;
  action: string;
  args: Record<string, unknown>;
  source: string;
  consumed: boolean;
}

// A one-dispatch receipt, unavailable to tool arguments or model-authored metadata.
// Middleware still rechecks policy; this prevents a second prompt for identical work.
const authorizations = new AsyncLocalStorage<Authorization>();

export function withDispatchAuthorization<T>(
  context: AgentContext, toolId: string, action: string,
  args: Record<string, unknown>, source: string, execute: () => Promise<T>,
): Promise<T> {
  return authorizations.run({
    userId: context.userId, sessionId: context.sessionId, agentId: context.id,
    toolId, action, args: structuredClone(args), source, consumed: false,
  }, execute);
}

export function consumeDispatchAuthorization(
  context: AgentContext, toolId: string, action: string, args: Record<string, unknown>,
): string | undefined {
  const receipt = authorizations.getStore();
  if (!receipt || receipt.consumed || receipt.userId !== context.userId ||
      receipt.sessionId !== context.sessionId || receipt.agentId !== context.id ||
      receipt.toolId !== toolId || receipt.action !== action ||
      !isDeepStrictEqual(receipt.args, args)) return undefined;
  receipt.consumed = true;
  return receipt.source;
}

export class ApprovalBlockedError extends Error {
  readonly code = 'approval_required';
  constructor(message: string) { super(message); this.name = 'ApprovalBlockedError'; }
}
