'use client';

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  GitCompare,
  Plus,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ScoreBar } from '@/components/eval/ScoreBar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';

interface EvalRunSummary {
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
}

interface CellData {
  passed: boolean;
  score: number;
  latencyMs: number;
  assertions: { type: string; passed: boolean; score: number }[];
}

interface CompareData {
  evalRuns: EvalRunSummary[];
  testIds: string[];
  matrix: Record<string, Record<string, CellData>>;
}

interface EvalListItem {
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
}

export default function ComparePage() {
  const searchParams = useSearchParams();
  const initialIds = searchParams.get('ids')?.split(',').filter(Boolean) || [];

  const [selectedIds, setSelectedIds] = useState<string[]>(initialIds);
  const [compareData, setCompareData] = useState<CompareData | null>(null);
  const [availableRuns, setAvailableRuns] = useState<EvalListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Fetch available eval runs for selection
  const fetchAvailable = useCallback(async () => {
    try {
      const data = await api.get<{ results: EvalListItem[] }>('/eval/results');
      setAvailableRuns(data.results || []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchAvailable();
  }, [fetchAvailable]);

  // Fetch comparison when we have 2+ selected
  const fetchComparison = useCallback(async () => {
    if (selectedIds.length < 2) {
      setCompareData(null);
      return;
    }
    setLoading(true);
    try {
      const data = await api.get<CompareData>(`/eval/compare?ids=${selectedIds.join(',')}`);
      setCompareData(data);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedIds]);

  useEffect(() => {
    fetchComparison();
  }, [fetchComparison]);

  const addRun = (id: string) => {
    if (!selectedIds.includes(id) && selectedIds.length < 5) {
      setSelectedIds([...selectedIds, id]);
    }
  };

  const removeRun = (id: string) => {
    setSelectedIds(selectedIds.filter(x => x !== id));
  };

  // Detect regressions: test passed in first run but failed in later run
  const isRegression = (testId: string, evalId: string): boolean => {
    if (!compareData) return false;
    const cell = compareData.matrix[testId]?.[evalId];
    if (!cell || cell.passed) return false;
    // Check if earlier runs passed
    const idx = compareData.evalRuns.findIndex(r => r.id === evalId);
    for (let i = 0; i < idx; i++) {
      const prevCell = compareData.matrix[testId]?.[compareData.evalRuns[i].id];
      if (prevCell?.passed) return true;
    }
    return false;
  };

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div>
        <Link
          href="/eval"
          className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Evaluations
        </Link>

        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-base font-semibold lowercase"><span className="text-outline">octi:</span><span className="text-on-surface">~/eval/compare</span><span className="text-primary font-bold"> $</span><span aria-hidden className="term-caret" /></h1>
            <p className="text-sm text-on-surface-variant">
              Select 2-5 eval runs to compare side by side
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-error-container/60 border border-error/40 rounded-xl px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline cursor-pointer">dismiss</button>
        </div>
      )}

      {/* Run selection */}
      <Card>
        <CardHeader>
          <CardTitle>Selected Runs ({selectedIds.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Selected runs */}
          <div className="flex flex-wrap gap-2 mb-4">
            {selectedIds.map((id, i) => {
              const run = availableRuns.find(r => r.id === id);
              return (
                <div
                  key={id}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 text-primary rounded-lg text-sm"
                >
                  <span className="font-mono text-xs">{id.slice(5, 24)}</span>
                  {run && (
                    <span className="text-xs text-on-surface-variant" suppressHydrationWarning>
                      ({Math.round((run.summary.passRate ?? run.summary.averageScore ?? 0) * 100)}%)
                    </span>
                  )}
                  <button
                    onClick={() => removeRun(id)}
                    className="p-0.5 hover:bg-primary/20 rounded cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Available runs to add */}
          {availableRuns.filter(r => !selectedIds.includes(r.id)).length > 0 && (
            <div>
              <p className="text-xs text-on-surface-variant mb-2">Add a run:</p>
              <div className="flex flex-wrap gap-2">
                {availableRuns
                  .filter(r => !selectedIds.includes(r.id))
                  .slice(0, 10)
                  .map(run => (
                    <button
                      key={run.id}
                      onClick={() => addRun(run.id)}
                      disabled={selectedIds.length >= 5}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-outline-variant/10 text-on-surface-variant rounded-lg text-xs hover:bg-surface-container cursor-pointer disabled:opacity-40"
                    >
                      <Plus className="w-3 h-3" />
                      <span className="font-mono">{run.id.slice(5, 24)}</span>
                      <span className="text-on-surface-variant" suppressHydrationWarning>
                        {Math.round((run.summary.passRate ?? run.summary.averageScore ?? 0) * 100)}%
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-5 h-5 animate-spin text-on-surface-variant mr-2" />
          <span className="text-on-surface-variant">Loading comparison...</span>
        </div>
      )}

      {/* Comparison matrix */}
      {compareData && !loading && (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-outline-variant/10">
                  <th className="px-4 py-3 text-left text-sm font-medium text-on-surface-variant sticky left-0 bg-surface-container z-10 min-w-[200px]">
                    Test ID
                  </th>
                  {compareData.evalRuns.map((run, i) => (
                    <th
                      key={run.id}
                      className="px-4 py-3 text-center text-sm font-medium text-on-surface-variant min-w-[160px]"
                    >
                      <div className="text-xs font-mono">{run.id.slice(5, 24)}</div>
                      <div className="text-[10px] text-on-surface-variant mt-0.5" suppressHydrationWarning>
                        {formatDate(run.timestamp)}
                      </div>
                      <ScoreBar score={run.summary.passRate ?? run.summary.averageScore ?? 0} size="sm" />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareData.testIds.map(testId => (
                  <tr
                    key={testId}
                    className="border-b border-outline-variant/10 hover:bg-surface-container/30"
                  >
                    <td className="px-4 py-2.5 text-sm font-mono text-on-surface sticky left-0 bg-surface-container z-10">
                      {testId}
                    </td>
                    {compareData.evalRuns.map(run => {
                      const cell = compareData.matrix[testId]?.[run.id];
                      const regression = isRegression(testId, run.id);

                      if (!cell) {
                        return (
                          <td key={run.id} className="px-4 py-2.5 text-center">
                            <span className="text-xs text-on-surface-variant">-</span>
                          </td>
                        );
                      }

                      return (
                        <td
                          key={run.id}
                          className={cn(
                            'px-4 py-2.5 text-center',
                            cell.passed
                              ? 'bg-tertiary-container/60'
                              : regression
                                ? 'bg-warning-container/60'
                                : 'bg-error-container/60'
                          )}
                        >
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center gap-1">
                              {cell.passed ? (
                                <CheckCircle className="w-4 h-4 text-tertiary" />
                              ) : regression ? (
                                <AlertTriangle className="w-4 h-4 text-warning" />
                              ) : (
                                <XCircle className="w-4 h-4 text-error" />
                              )}
                              <span className="text-xs font-mono">
                                {Math.round(cell.score * 100)}%
                              </span>
                            </div>
                            <span className="text-[10px] text-on-surface-variant">
                              {cell.latencyMs > 1000
                                ? `${(cell.latencyMs / 1000).toFixed(1)}s`
                                : `${cell.latencyMs}ms`}
                            </span>
                            {regression && (
                              <span className="text-[10px] text-warning font-medium">
                                REGRESSION
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedIds.length < 2 && !loading && (
        <Card>
          <CardContent className="text-center py-12">
            <GitCompare className="w-12 h-12 mx-auto mb-3 text-on-surface-variant" />
            <p className="text-on-surface-variant">Select at least 2 eval runs to compare</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
