'use client';

import { Coins } from 'lucide-react';

interface SessionStatsProps {
  totalTokens: number;
  budget?: number;
}

export function SessionStats({ totalTokens, budget = 100_000 }: SessionStatsProps) {
  if (totalTokens === 0) return null;

  const pct = Math.min((totalTokens / budget) * 100, 100);
  const isWarning = pct >= 80;

  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-500">
      <Coins className="w-3.5 h-3.5" />
      <span className={isWarning ? 'text-yellow-600 dark:text-yellow-400 font-medium' : ''}>
        {totalTokens.toLocaleString()}t
      </span>
      <div className="w-16 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isWarning ? 'bg-yellow-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
