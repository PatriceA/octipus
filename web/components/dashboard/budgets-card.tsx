'use client';

import { Wallet } from 'lucide-react';
import { useEffect } from 'react';
import { SpendBudgetMeter } from '@/components/spend-budget-meter';
import { Card } from '@/components/ui/card';
import { useMyBudgets } from '@/lib/spend-budgets';

/**
 * The caller's dollar spend budgets, read-only: spend vs limit, state and
 * reset time. Anchored at `#budgets` so notifications and the banner can link
 * straight to it. Admins set budgets at /admin/quotas.
 */
export function BudgetsCard() {
  const { data, isPending, isError } = useMyBudgets();
  const budgets = data?.budgets ?? [];

  // Arriving via /#budgets: the card renders after the data loads, so the
  // browser's own anchor jump has already happened by then.
  useEffect(() => {
    if (budgets.length > 0 && typeof window !== 'undefined' && window.location.hash === '#budgets') {
      document.getElementById('budgets')?.scrollIntoView({ block: 'start' });
    }
  }, [budgets.length]);

  return (
    <Card className="p-4">
      <div id="budgets" data-testid="budgets-card" className="scroll-mt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-warning" aria-hidden />
          <p className="text-sm text-on-surface">Spend budgets</p>
          <span className="text-[11px] text-on-surface-variant">
            agents pause when one is reached · set by an admin
          </span>
        </div>
        {isPending ? (
          <p className="text-xs text-on-surface-variant">Loading…</p>
        ) : isError ? (
          <p className="text-xs text-warning">Could not load your budgets.</p>
        ) : budgets.length === 0 ? (
          <p className="text-xs text-on-surface-variant">No spend budget is set for you — agents are not capped by cost.</p>
        ) : (
          <div className="space-y-4">
            {budgets.map((b) => <SpendBudgetMeter key={b.id} budget={b} />)}
          </div>
        )}
      </div>
    </Card>
  );
}
