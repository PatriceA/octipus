/**
 * Dollar spend budgets — the shapes the API returns and the wording every
 * surface (admin section, budgets card, global banner, chat refusal,
 * notifications) shares, so a budget reads the same wherever it shows up.
 *
 * Backend: `src/security/spend-budgets.ts` (`SpendBudgetView`),
 * GET /api/spend-budgets/me, /api/admin/spend-budgets.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export type SpendScopeKind = 'user' | 'role' | 'workspace';
export type SpendPeriod = 'day' | 'month';
export type SpendState = 'ok' | 'warned' | 'paused';

/** Mirrors `SpendBudgetView` in src/security/spend-budgets.ts. */
export interface SpendBudgetView {
  id: string;
  userId: string;
  scopeKind: SpendScopeKind;
  scopeRef: string | null;
  scopeName: string | null;
  period: SpendPeriod;
  limitUsd: number;
  warnRatio: number;
  spentUsd: number;
  estimatedUsd: number;
  unmeasuredCalls: number;
  unmeasured: boolean;
  percent: number;
  state: SpendState;
  periodStart: string;
  resetsAt: string;
  pausedAt: string | null;
  warnedAt: string | null;
  updatedAt: string;
}

/** `reason` of SpendBudgetExceededError, as chat receives it on `metadata.limit`. */
export interface SpendRefusalReason {
  budgetId: string;
  userId: string;
  scopeKind: SpendScopeKind;
  scopeRef: string | null;
  period: SpendPeriod;
  spentUsd: number;
  limitUsd: number;
  resetsAt?: string;
}

export type LimitRefusal =
  | { code: 'SPEND_BUDGET_EXCEEDED'; reason: SpendRefusalReason }
  | { code: 'QUOTA_EXCEEDED'; reason: { kind: string; current: number; max: number; userId: string } };

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "Your monthly", "Role coder daily", "Workspace Client A monthly". */
export function scopeLabel(b: { scopeKind: SpendScopeKind; scopeRef: string | null; scopeName?: string | null }): string {
  if (b.scopeKind === 'user') return 'your';
  if (b.scopeKind === 'role') return `role "${b.scopeName ?? b.scopeRef}"`;
  const ref = b.scopeName ?? (b.scopeRef ? `${b.scopeRef.slice(0, 8)}…` : '?');
  return `workspace "${ref}"`;
}

export function scopeTitle(b: { scopeKind: SpendScopeKind; scopeRef: string | null; scopeName?: string | null }): string {
  if (b.scopeKind === 'user') return 'All agents';
  const label = scopeLabel(b);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function periodWord(p: SpendPeriod): string {
  return p === 'day' ? 'daily' : 'monthly';
}

/** Local reset time, plus a relative hint: "Sep 29, 02:00 (in 5h)". */
export function resetLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const abs = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ms = d.getTime() - now.getTime();
  if (!(ms > 0)) return abs;
  const h = Math.floor(ms / 3_600_000);
  const rel = h >= 48 ? `in ${Math.round(h / 24)}d` : h >= 1 ? `in ${h}h` : `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  return `${abs} (${rel})`;
}

export function stateVariant(s: SpendState): 'danger' | 'warning' | 'success' {
  return s === 'paused' ? 'danger' : s === 'warned' ? 'warning' : 'success';
}

export const MY_BUDGETS_KEY = ['spend-budgets', 'me'] as const;

/**
 * The caller's budgets. One query key, so the banner, the dashboard card and
 * any other consumer share one fetch: refreshed every 60s, and on mount or
 * window focus only once the data is older than 30s.
 */
export function useMyBudgets() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: MY_BUDGETS_KEY,
    queryFn: () => api.get<{ budgets?: SpendBudgetView[] }>('/spend-budgets/me'),
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
