'use client';

import { AlertTriangle, PauseCircle, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  fmtUsd, periodWord, resetLabel, scopeLabel, type SpendBudgetView, useMyBudgets,
} from '@/lib/spend-budgets';
import { useWorkspace } from '@/lib/workspace-context';

const DISMISS_KEY = 'octipus.spend-banner-dismissed';

function readDismissed(): string[] {
  try {
    const raw = window.sessionStorage.getItem(DISMISS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Per budget per period, so the next period's pause shows again. */
function pausedKey(b: SpendBudgetView): string {
  return `paused:${b.id}@${b.periodStart}`;
}

/** One key per set of warned budgets per period, so a new warning shows again. */
function warningKey(warned: SpendBudgetView[]): string {
  return `warn:${warned.map((b) => `${b.id}@${b.periodStart}`).sort().join(',')}`;
}

/** Who is paused: all agents, or only those in one role / workspace. */
function pausedWho(b: SpendBudgetView): string {
  if (b.scopeKind === 'user') return 'Agents are paused';
  if (b.scopeKind === 'role') return `Agents in role "${b.scopeName ?? b.scopeRef}" are paused`;
  const ws = b.scopeName ?? (b.scopeRef ? `${b.scopeRef.slice(0, 8)}…` : '?');
  return `Agents in workspace "${ws}" are paused`;
}

function budgetPhrase(b: SpendBudgetView): string {
  const whose = b.scopeKind === 'user' ? 'your ' : '';
  return `${whose}${periodWord(b.period)} budget of ${fmtUsd(b.limitUsd)}/${b.period}`;
}

/**
 * Global spend-budget banner, mounted at the top of the app shell like the
 * impersonation bar. It says only what is actually paused:
 *
 * - A user-scope pause, or a pause of the workspace the user is working in,
 *   stops their agents here → red, not dismissible.
 * - A role pause, or another workspace's, stops only those agents → red,
 *   dismissible for this browser session.
 * - Otherwise a budget at or over its warn ratio → amber, dismissible for
 *   the session (a new warning or a new period shows again).
 *
 * Data: GET /api/spend-budgets/me via the shared `useMyBudgets` query.
 */
export function SpendBudgetBanner() {
  const { data } = useMyBudgets();
  const { activeWorkspace } = useWorkspace();
  const [dismissed, setDismissed] = useState<string[]>(() => (typeof window === 'undefined' ? [] : readDismissed()));
  const budgets = data?.budgets ?? [];
  const activeWs = activeWorkspace?.id.toLowerCase() ?? null;

  const dismiss = (key: string) => {
    const next = [...dismissed.filter((k) => k !== key), key];
    try { window.sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* storage blocked: dismiss for this render tree only */ }
    setDismissed(next);
  };

  const paused = budgets.filter((b) => b.state === 'paused');
  const blocking = paused.filter((b) => b.scopeKind === 'user' || (b.scopeKind === 'workspace' && b.scopeRef === activeWs));
  const partial = paused.filter((b) => !blocking.includes(b) && !dismissed.includes(pausedKey(b)));
  // Blocking pauses first: they cannot be dismissed, so they always win.
  const shown = blocking[0] ?? partial[0];

  if (shown) {
    const canDismiss = !blocking.includes(shown);
    const more = blocking.length + partial.length - 1;
    return (
      <div
        role="alert"
        data-testid="spend-budget-banner"
        data-state="paused"
        data-scope={shown.scopeKind}
        className="relative z-50 w-full bg-error-container border-b border-error/60 text-on-surface px-4 py-2 text-sm font-mono"
      >
        <div className="flex items-center gap-2 min-w-0">
          <PauseCircle className="w-4 h-4 shrink-0 text-error" aria-hidden />
          <span className="min-w-0">
            <strong className="text-error">{pausedWho(shown)}:</strong>{' '}
            {budgetPhrase(shown)} reached ({fmtUsd(shown.spentUsd)} spent).{' '}
            <span suppressHydrationWarning>Resets {resetLabel(shown.resetsAt)}.</span>{' '}
            Ask an admin to raise it.
            {more > 0 && <span className="text-on-surface-variant"> (+{more} more paused)</span>}
          </span>
          <Link href="/#budgets" className="ml-auto shrink-0 text-xs text-error underline">budgets →</Link>
          {canDismiss && (
            <button
              type="button"
              onClick={() => dismiss(pausedKey(shown))}
              className="shrink-0 p-0.5 text-on-surface-variant hover:text-on-surface cursor-pointer"
              aria-label="Dismiss budget notice"
              title="Dismiss for this session"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  const warned = budgets.filter((b) => b.state === 'warned');
  if (warned.length === 0) return null;
  const key = warningKey(warned);
  if (dismissed.includes(key)) return null;
  const b = [...warned].sort((x, y) => y.percent - x.percent)[0];

  return (
    <div
      role="status"
      data-testid="spend-budget-banner"
      data-state="warned"
      data-scope={b.scopeKind}
      className="relative z-50 w-full bg-warning-container/60 border-b border-warning/50 text-on-surface px-4 py-1.5 text-sm font-mono"
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="w-4 h-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0">
          <strong className="text-warning">Spend budget almost reached:</strong>{' '}
          {scopeLabel(b)} {periodWord(b.period)} budget of {fmtUsd(b.limitUsd)}/{b.period} is at {Math.round(b.percent)}%
          ({fmtUsd(b.spentUsd)} spent).{' '}
          <span suppressHydrationWarning>Resets {resetLabel(b.resetsAt)}.</span>
          {warned.length > 1 && <span className="text-on-surface-variant"> (+{warned.length - 1} more)</span>}
        </span>
        <Link href="/#budgets" className="ml-auto shrink-0 text-xs text-warning underline">budgets →</Link>
        <button
          type="button"
          onClick={() => dismiss(key)}
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
