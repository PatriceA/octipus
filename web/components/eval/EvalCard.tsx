'use client';

import { CheckCircle, Clock, FlaskConical, XCircle } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { cn, formatDate } from '@/lib/utils';
import { ScoreBar } from './ScoreBar';

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
    averageScore?: number;
    passRate?: number;
  };
  suites: EvalSuiteSummary[];
}

function getScore(summary: EvalCardProps['summary']): number {
  return summary.passRate ?? summary.averageScore ?? 0;
}

export function EvalCard({ id, timestamp, summary, suites }: EvalCardProps) {
  const allPassed = summary.totalFailed === 0;

  return (
    <Link href={`/eval/view?id=${encodeURIComponent(id)}`}>
      <Card hover className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center',
              allPassed
                ? 'bg-tertiary-container/60'
                : 'bg-error-container/60'
            )}>
              {allPassed ? (
                <CheckCircle className="w-4 h-4 text-tertiary" />
              ) : (
                <XCircle className="w-4 h-4 text-error" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-on-surface">
                {suites.length === 1 ? suites[0].suite : `${suites.length} suites`}
              </p>
              <p className="text-xs text-on-surface-variant" suppressHydrationWarning>
                {formatDate(timestamp)}
              </p>
            </div>
          </div>
          <ScoreBar score={getScore(summary)} size="sm" />
        </div>

        <div className="flex items-center gap-4 text-xs text-on-surface-variant">
          <span className="flex items-center gap-1">
            <FlaskConical className="w-3 h-3" />
            {summary.totalTests} tests
          </span>
          <span className="flex items-center gap-1 text-tertiary">
            <CheckCircle className="w-3 h-3" />
            {summary.totalPassed}
          </span>
          {summary.totalFailed > 0 && (
            <span className="flex items-center gap-1 text-error">
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
