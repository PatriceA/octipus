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
    super(`Quota exceeded for ${reason.kind}: ${reason.current}/${reason.max}`);
    this.name = 'QuotaExceededError';
    this.reason = reason;
  }
}
