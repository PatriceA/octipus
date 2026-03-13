'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';
import { ScoreBar } from './ScoreBar';
import { CheckCircle, XCircle, Clock, FlaskConical } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface EvalSuiteSummary {
  suite: string;
  totalTests: number;
  passed: number;
  failed: number;
  score: number;
  duration: number;
  timestamp: string;
}

interface EvalCardProps {
  id: string;
  timestamp: string;
  summary: {
    totalSuites: number;
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    averageScore: number;
  };
  suites: EvalSuiteSummary[];
}

export function EvalCard({ id, timestamp, summary, suites }: EvalCardProps) {
  const allPassed = summary.totalFailed === 0;

  return (
    <Link href={`/eval/${encodeURIComponent(id)}`}>
      <Card hover className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center',
              allPassed
                ? 'bg-green-100 dark:bg-green-950/30'
                : 'bg-red-100 dark:bg-red-950/30'
            )}>
              {allPassed ? (
                <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {suites.length === 1 ? suites[0].suite : `${suites.length} suites`}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400" suppressHydrationWarning>
                {formatDate(timestamp)}
              </p>
            </div>
          </div>
          <ScoreBar score={summary.averageScore} size="sm" />
        </div>

        <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
          <span className="flex items-center gap-1">
            <FlaskConical className="w-3 h-3" />
            {summary.totalTests} tests
          </span>
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <CheckCircle className="w-3 h-3" />
            {summary.totalPassed}
          </span>
          {summary.totalFailed > 0 && (
            <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
              <XCircle className="w-3 h-3" />
              {summary.totalFailed}
            </span>
          )}
          <span className="flex items-center gap-1 ml-auto">
            <Clock className="w-3 h-3" />
            {suites.reduce((s, suite) => s + (suite.duration || 0), 0) > 1000
              ? `${(suites.reduce((s, suite) => s + (suite.duration || 0), 0) / 1000).toFixed(1)}s`
              : `${suites.reduce((s, suite) => s + (suite.duration || 0), 0)}ms`}
          </span>
        </div>
      </Card>
    </Link>
  );
}
