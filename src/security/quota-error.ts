/**
 * Phase 3c-2 — structured error for quota-gated operations.
 *
 * Thrown by enforcement points (agent-manager.spawn, agent-worker
 * pre-LLM-call, rate-limit middleware) when a user would exceed
 * their effective cap. The structured `reason` field lets callers
 * surface a precise message without re-parsing the error string.
 *
 * Distinct from the agent-internal `BudgetExceededError`
 * (`src/core/swarm/errors.ts`) — that one fires when a single
 * agent's per-spawn `maxTokenBudget` is exhausted; this one fires
 * when the user's cross-agent daily aggregate would be exceeded.
 * Catch sites can distinguish via `instanceof`.
 */
import type { QuotaKind } from './quotas';

export interface QuotaExceededReason {
  kind: QuotaKind;
  current: number;
  max: number;
  userId: string;
}

export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED';
  readonly reason: QuotaExceededReason;
  constructor(reason: QuotaExceededReason) {
    super(QuotaExceededError.formatMessage(reason));
    this.name = 'QuotaExceededError';
    this.reason = reason;
  }

  // The `tokensPerDay` cap is a *platform-side safety budget* aggregated
  // across every agent the user spawns — independent of which provider
  // billed those tokens. Pay-per-token providers (Deepseek, OpenAI, etc.)
  // have no such cap; this error fires only because the user-level
  // budget is exhausted. Surface that distinction here so the error
  // message doesn't read like a provider rejection.
  private static formatMessage(r: QuotaExceededReason): string {
    const base = `Quota exceeded for ${r.kind}: ${r.current}/${r.max}`;
    if (r.kind === 'tokensPerDay') {
      return `${base}. This is a per-user daily safety budget across all models, not a provider limit. Raise or disable it at /admin/quotas (set 0 = unlimited), or via the agent.maxTokenBudget setting.`;
    }
    if (r.kind === 'concurrentAgents') {
      return `${base}. Raise the cap at /admin/quotas or via agent.maxConcurrentAgents.`;
    }
    if (r.kind === 'apiCallsPerMinute') {
      return `${base}. Raise the cap at /admin/quotas or via api.rateLimitMax.`;
    }
    return base;
  }
}
