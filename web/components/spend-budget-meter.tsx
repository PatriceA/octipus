'use client';

import { StatusBadge } from '@/components/ui/status-badge';
import {
  fmtUsd, periodWord, resetLabel, scopeTitle, type SpendBudgetView, stateVariant,
} from '@/lib/spend-budgets';

/**
 * One spend budget: scope, spend-vs-limit bar with the warn mark, state badge
 * and reset time. Shared by the admin section and the user's budgets card.
 */
export function SpendBudgetMeter({ budget: b, actions }: { budget: SpendBudgetView; actions?: React.ReactNode }) {
  const pct = Math.min(100, Math.max(0, b.percent));
  const tone = b.state === 'paused' ? 'bg-error' : b.state === 'warned' ? 'bg-warning' : 'bg-primary';
  return (
    <div className="space-y-1.5" data-testid="spend-budget" data-state={b.state}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-on-surface font-medium">{scopeTitle(b)}</span>
        <span className="text-[11px] text-on-surface-variant">{periodWord(b.period)}</span>
        <StatusBadge variant={stateVariant(b.state)} dot>
          {b.state === 'paused' ? 'PAUSED' : b.state}
        </StatusBadge>
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </div>
      <div className="flex items-baseline gap-2 text-xs tabular-nums">
        <span className="text-on-surface">{fmtUsd(b.spentUsd)}</span>
        <span className="text-on-surface-variant">/ {fmtUsd(b.limitUsd)} per {b.period}</span>
        <span className="text-on-surface-variant">· {Math.round(b.percent)}%</span>
        <span className="text-on-surface-variant ml-auto" suppressHydrationWarning>resets {resetLabel(b.resetsAt)}</span>
      </div>
      <div
        className="relative h-1.5 w-full bg-surface-container-high rounded"
        role="progressbar"
        aria-label={`${scopeTitle(b)} ${periodWord(b.period)} spend`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className={`h-1.5 rounded ${tone}`} style={{ width: `${pct}%` }} />
        <div
          className="absolute top-[-2px] h-[10px] w-px bg-warning"
          style={{ left: `${Math.min(100, b.warnRatio * 100)}%` }}
          title={`Warning at ${Math.round(b.warnRatio * 100)}%`}
        />
      </div>
      {(b.unmeasured || b.estimatedUsd > 0) && (
        <p className="text-[11px] text-on-surface-variant">
          {b.estimatedUsd > 0 && <>Includes {fmtUsd(b.estimatedUsd)} estimated from model pricing. </>}
          {b.unmeasured && (
            <>
              {b.unmeasuredCalls} call{b.unmeasuredCalls === 1 ? '' : 's'} this {b.period} reported no cost
              (CLI / subscription providers) and count as $0 — real spend may be higher.
            </>
          )}
        </p>
      )}
    </div>
  );
}
