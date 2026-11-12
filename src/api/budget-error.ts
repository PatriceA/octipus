import { QuotaExceededError } from '@/security/quota-error';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';

/** Only intentional, typed budget refusals are safe to expose as client errors. */
export function budgetErrorBody(error: unknown): { error: string; code: string } | null {
  return error instanceof QuotaExceededError || error instanceof SpendBudgetExceededError
    ? { error: error.message, code: error.code } : null;
}
