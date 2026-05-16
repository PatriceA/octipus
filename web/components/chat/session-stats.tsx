'use client';

import { cn } from '@/lib/utils';

interface SessionStatsProps {
  totalTokens: number;
  budget?: number;
}

/**
 * Token-budget meter rendered as a TUI gauge. Format mimics the
 * status-bar token counter from `src/tui-pi/components/status-bar.ts`:
 * `12.3k / 100k ▓▓▓░░░░`.
 */
export function SessionStats({ totalTokens, budget = 100_000 }: SessionStatsProps) {
  if (totalTokens === 0) return null;

  const pct = Math.min((totalTokens / budget) * 100, 100);
  const isWarning = pct >= 80;
  const isCritical = pct >= 95;

  return (
    <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
      <span className={cn('text-on-surface-variant', isCritical && 'text-error', isWarning && !isCritical && 'text-warning')}>
        {totalTokens.toLocaleString()}t / {budget.toLocaleString()}t
      </span>
      <div className="relative w-20 h-1.5 bg-outline-variant/30 rounded-xs overflow-hidden">
        <div
          className={cn(
            'h-full transition-all',
            isCritical ? 'bg-error' : isWarning ? 'bg-warning' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
