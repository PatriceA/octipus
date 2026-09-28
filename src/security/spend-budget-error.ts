/**
 * Structured error for a dollar spend budget that is exhausted.
 *
 * Thrown by `checkSpend` (`src/security/spend-budgets.ts`) at the
 * enforcement points — agent-manager.spawn, agent-worker pre-LLM-call,
 * cli-agent-worker before the CLI starts. Kept in its own file, like
 * `quota-error.ts`, so catch sites can `instanceof` it without pulling
 * the DB schema in.
 *
 * Distinct from `QuotaExceededError` (token / concurrency / rate caps):
 * this one is a USD cap summed from `cost_log`, and it stays paused until
 * the period rolls over or an admin raises the limit or clears the pause.
 */
import type { SpendPeriod, SpendScopeKind } from '@/db/schema/spend-budgets';

export interface SpendBudgetExceededReason {
  budgetId: string;
  userId: string;
  scopeKind: SpendScopeKind;
  scopeRef: string | null;
  period: SpendPeriod;
  spentUsd: number;
  limitUsd: number;
  /** ISO start of the next period, when the pause lifts on its own. */
  resetsAt?: string;
}

export class SpendBudgetExceededError extends Error {
  readonly code = 'SPEND_BUDGET_EXCEEDED';
  readonly reason: SpendBudgetExceededReason;
  constructor(reason: SpendBudgetExceededReason) {
    super(SpendBudgetExceededError.formatMessage(reason));
    this.name = 'SpendBudgetExceededError';
    this.reason = reason;
  }

  private static formatMessage(r: SpendBudgetExceededReason): string {
    const scope = r.scopeKind === 'user' ? 'user' : `${r.scopeKind} ${r.scopeRef}`;
    return `Spend budget exceeded for ${scope} (per ${r.period}): $${r.spentUsd.toFixed(2)}/$${r.limitUsd.toFixed(2)}. `
      + `Agents are paused until the period rolls over${r.resetsAt ? ` (${r.resetsAt})` : ''}. `
      + 'Raise the limit or clear the pause at /api/admin/spend-budgets.';
  }
}
