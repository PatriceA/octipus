/**
 * A turn refused by a user cap — a dollar spend budget
 * (`SpendBudgetExceededError`) or a token / concurrency / rate quota
 * (`QuotaExceededError`) — turned into what the user reads in chat plus the
 * structured `reason` the web client renders as a card.
 *
 * Both errors used to reach chat as "I encountered an error…" or, worse,
 * "Task was stopped" (the worker aborts itself on a spend pause, which the
 * root runner read as a user stop). The text names the budget, the limit,
 * the spend and when it resets, so a user on any channel (web, Telegram,
 * Slack) knows what happened and who can change it.
 */
import { QuotaExceededError, type QuotaExceededReason } from '@/security/quota-error';
import { SpendBudgetExceededError, type SpendBudgetExceededReason } from '@/security/spend-budget-error';

export type LimitRefusal =
  | { code: 'SPEND_BUDGET_EXCEEDED'; reason: SpendBudgetExceededReason }
  | { code: 'QUOTA_EXCEEDED'; reason: QuotaExceededReason };

function isSpendError(err: unknown): err is SpendBudgetExceededError {
  // `name` as well as `instanceof`: agent-worker and agent-manager rethrow by
  // name, and a dynamic import can yield a second copy of the class.
  return err instanceof SpendBudgetExceededError
    || (err instanceof Error && err.name === 'SpendBudgetExceededError' && 'reason' in err);
}

function isQuotaError(err: unknown): err is QuotaExceededError {
  return err instanceof QuotaExceededError
    || (err instanceof Error && err.name === 'QuotaExceededError' && 'reason' in err);
}

/** True when `err` is a user cap, not a failure — callers must not report it as a stop or retry it. */
export function isLimitError(err: unknown): boolean {
  return isSpendError(err) || isQuotaError(err);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "2026-09-29 00:00 UTC" — the server does not know the reader's time zone. */
function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function spendScopeLabel(r: Pick<SpendBudgetExceededReason, 'scopeKind' | 'scopeRef' | 'period'>): string {
  const every = r.period === 'day' ? 'daily' : 'monthly';
  if (r.scopeKind === 'user') return `your ${every} spend budget`;
  if (r.scopeKind === 'role') return `the ${every} spend budget for the "${r.scopeRef}" role`;
  return `the ${every} spend budget for workspace ${r.scopeRef}`;
}

/** The chat text and structured payload for a limit error; null for anything else. */
export function limitRefusalOf(err: unknown): { text: string; refusal: LimitRefusal } | null {
  if (isSpendError(err)) {
    const r = err.reason;
    const resets = r.resetsAt ? ` It resets ${utc(r.resetsAt)}.` : '';
    const text = `Agents are paused: ${spendScopeLabel(r)} of ${usd(r.limitUsd)}/${r.period} is reached `
      + `(${usd(r.spentUsd)} spent this ${r.period}).${resets} Ask an admin to raise the limit.`;
    return { text, refusal: { code: 'SPEND_BUDGET_EXCEEDED', reason: r } };
  }
  if (isQuotaError(err)) {
    return { text: err.message, refusal: { code: 'QUOTA_EXCEEDED', reason: err.reason } };
  }
  return null;
}
