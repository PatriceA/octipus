'use client';

import { AlertTriangle, PauseCircle, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  fmtUsd, periodWord, resetLabel, scopeLabel, type SpendBudgetView, useMyBudgets,
} from '@/lib/spend-budgets';

const DISMISS_KEY = 'octipus.spend-warning-dismissed';

/** One key per set of warned budgets per period, so a new warning shows again. */
function warningKey(warned: SpendBudgetView[]): string {
  return warned.map((b) => `${b.id}@${b.periodStart}`).sort().join(',');
}

function readDismissed(): string | null {
  try { return window.sessionStorage.getItem(DISMISS_KEY); } catch { return null; }
}

function describe(b: SpendBudgetView): string {
  return `${scopeLabel(b)} ${periodWord(b.period)} budget of ${fmtUsd(b.limitUsd)}/${b.period}`;
}

/**
 * Global spend-budget banner, mounted at the top of the app shell like the
 * impersonation bar.
 *
 * - Any budget PAUSED → a red bar naming it, the spend and the reset time.
 *   Not dismissible: every agent run is being refused until it lifts.
 * - Otherwise any budget at or over its warn ratio → a softer amber bar,
 *   dismissible for this browser session (it returns for a new warning).
 *
 * Data: GET /api/spend-budgets/me, polled every 60s and on navigation.
 */
export function SpendBudgetBanner() {
  const { data } = useMyBudgets();
  const [dismissed, setDismissed] = useState<string | null>(() => (typeof window === 'undefined' ? null : readDismissed()));
  const budgets = data?.budgets ?? [];
  const paused = budgets.filter((b) => b.state === 'paused');
  const warned = budgets.filter((b) => b.state === 'warned');

  if (paused.length > 0) {
    const b = paused[0];
    return (
      <div
        role="alert"
        data-testid="spend-budget-banner"
        data-state="paused"
        className="relative z-50 w-full bg-error-container border-b border-error/60 text-on-surface px-4 py-2 text-sm font-mono"
      >
        <div className="flex items-center gap-2 min-w-0">
          <PauseCircle className="w-4 h-4 shrink-0 text-error" aria-hidden />
          <span className="min-w-0">
            <strong className="text-error">Agents are paused:</strong>{' '}
            {describe(b)} reached ({fmtUsd(b.spentUsd)} spent).{' '}
            <span suppressHydrationWarning>Resets {resetLabel(b.resetsAt)}.</span>{' '}
            Ask an admin to raise it.
            {paused.length > 1 && <span className="text-on-surface-variant"> (+{paused.length - 1} more paused)</span>}
          </span>
          <Link href="/#budgets" className="ml-auto shrink-0 text-xs text-error underline">budgets →</Link>
        </div>
      </div>
    );
  }

  if (warned.length === 0) return null;
  const key = warningKey(warned);
  if (dismissed === key) return null;
  const b = [...warned].sort((x, y) => y.percent - x.percent)[0];

  const dismiss = () => {
    try { window.sessionStorage.setItem(DISMISS_KEY, key); } catch { /* storage blocked: dismiss for this render tree only */ }
    setDismissed(key);
  };

  return (
    <div
      role="status"
      data-testid="spend-budget-banner"
      data-state="warned"
      className="relative z-50 w-full bg-warning-container/60 border-b border-warning/50 text-on-surface px-4 py-1.5 text-sm font-mono"
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="w-4 h-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0">
          <strong className="text-warning">Spend budget almost reached:</strong>{' '}
          {describe(b)} is at {Math.round(b.percent)}% ({fmtUsd(b.spentUsd)} spent).{' '}
          <span suppressHydrationWarning>Resets {resetLabel(b.resetsAt)}.</span>
          {warned.length > 1 && <span className="text-on-surface-variant"> (+{warned.length - 1} more)</span>}
        </span>
        <Link href="/#budgets" className="ml-auto shrink-0 text-xs text-warning underline">budgets →</Link>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 p-0.5 text-on-surface-variant hover:text-on-surface cursor-pointer"
          aria-label="Dismiss budget warning"
          title="Dismiss for this session"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
