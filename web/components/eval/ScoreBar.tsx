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
    pct >= 80 ? 'bg-green-500' :
    pct >= 50 ? 'bg-yellow-500' :
    'bg-red-500';

  const trackColor =
    pct >= 80 ? 'bg-green-950/30' :
    pct >= 50 ? 'bg-yellow-950/30' :
    'bg-red-950/30';

  return (
    <div className="flex items-center gap-2">
      <div className={cn(
        'rounded-full overflow-hidden',
        trackColor,
        size === 'sm' ? 'w-16 h-1.5' : 'w-24 h-2'
      )}>
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className={cn(
          'font-mono font-medium',
          size === 'sm' ? 'text-xs' : 'text-sm',
          pct >= 80 ? 'text-green-400' :
          pct >= 50 ? 'text-yellow-400' :
          'text-error'
        )}>
          {pct}%
        </span>
      )}
    </div>
  );
}
