'use client';

import { cn } from '@/lib/utils';

interface ScoreBarProps {
  score: number; // 0-1
  size?: 'sm' | 'md';
  showLabel?: boolean;
}

export function ScoreBar({ score, size = 'md', showLabel = true }: ScoreBarProps) {
  const safeScore = (score != null && !isNaN(score)) ? score : 0;
  const pct = Math.round(safeScore * 100);
  const color =
    pct >= 80 ? 'bg-tertiary' :
    pct >= 50 ? 'bg-warning' :
    'bg-error';

  const trackColor =
    pct >= 80 ? 'bg-tertiary-container/40' :
    pct >= 50 ? 'bg-warning-container/40' :
    'bg-error-container/40';

  return (
    <div className="flex items-center gap-2">
      <div className={cn(
        'rounded-xs overflow-hidden',
        trackColor,
        size === 'sm' ? 'w-16 h-1.5' : 'w-24 h-2'
      )}>
        <div
          className={cn('relative h-full rounded-xs transition-all', color)}
          style={{ width: `${pct}%` }}
        >
          {/* orchid marker at the score edge — AI-judged value */}
          {pct > 0 && pct < 100 && (
            <span aria-hidden className="absolute inset-y-0 right-0 w-px bg-accent" />
          )}
        </div>
      </div>
      {showLabel && (
        <span className={cn(
          'font-mono font-medium',
          size === 'sm' ? 'text-xs' : 'text-sm',
          pct >= 80 ? 'text-tertiary' :
          pct >= 50 ? 'text-warning' :
          'text-error'
        )}>
          {pct}%
        </span>
      )}
    </div>
  );
}
