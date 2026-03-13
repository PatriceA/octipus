'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  GitCompare,
  RefreshCw,
  ArrowLeft,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Plus,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScoreBar } from '@/components/eval/ScoreBar';

interface EvalRunSummary {
  id: string;
  timestamp: string;
  summary: {
    totalSuites: number;
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    averageScore: number;
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
    averageScore: number;
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
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Evaluations
        </Link>

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <GitCompare className="w-5 h-5 text-primary-700 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Compare Evaluations</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Select 2-5 eval runs to compare side by side
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
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
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary-50 dark:bg-primary-950/30 text-primary-700 dark:text-primary-400 rounded-lg text-sm"
                >
                  <span className="font-mono text-xs">{id.slice(5, 24)}</span>
                  {run && (
                    <span className="text-xs text-gray-500" suppressHydrationWarning>
                      ({Math.round((run.summary.averageScore || 0) * 100)}%)
                    </span>
                  )}
                  <button
                    onClick={() => removeRun(id)}
                    className="p-0.5 hover:bg-primary-100 dark:hover:bg-primary-900/30 rounded cursor-pointer"
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
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Add a run:</p>
              <div className="flex flex-wrap gap-2">
                {availableRuns
                  .filter(r => !selectedIds.includes(r.id))
                  .slice(0, 10)
                  .map(run => (
                    <button
                      key={run.id}
                      onClick={() => addRun(run.id)}
                      disabled={selectedIds.length >= 5}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-xs hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer disabled:opacity-40"
                    >
                      <Plus className="w-3 h-3" />
                      <span className="font-mono">{run.id.slice(5, 24)}</span>
                      <span className="text-gray-400" suppressHydrationWarning>
                        {Math.round((run.summary.averageScore || 0) * 100)}%
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
          <RefreshCw className="w-5 h-5 animate-spin text-gray-500 mr-2" />
          <span className="text-gray-500">Loading comparison...</span>
        </div>
      )}

      {/* Comparison matrix */}
      {compareData && !loading && (
        <div className="bg-white dark:bg-[#131C2E] rounded-xl shadow-sm ring-1 ring-primary-100 dark:ring-[#1E2D45] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 sticky left-0 bg-white dark:bg-[#131C2E] z-10 min-w-[200px]">
                    Test ID
                  </th>
                  {compareData.evalRuns.map((run, i) => (
                    <th
                      key={run.id}
                      className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400 min-w-[160px]"
                    >
                      <div className="text-xs font-mono">{run.id.slice(5, 24)}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5" suppressHydrationWarning>
                        {formatDate(run.timestamp)}
                      </div>
                      <ScoreBar score={run.summary.averageScore} size="sm" />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareData.testIds.map(testId => (
                  <tr
                    key={testId}
                    className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30"
                  >
                    <td className="px-4 py-2.5 text-sm font-mono text-gray-900 dark:text-gray-100 sticky left-0 bg-white dark:bg-[#131C2E] z-10">
                      {testId}
                    </td>
                    {compareData.evalRuns.map(run => {
                      const cell = compareData.matrix[testId]?.[run.id];
                      const regression = isRegression(testId, run.id);

                      if (!cell) {
                        return (
                          <td key={run.id} className="px-4 py-2.5 text-center">
                            <span className="text-xs text-gray-400">-</span>
                          </td>
                        );
                      }

                      return (
                        <td
                          key={run.id}
                          className={cn(
                            'px-4 py-2.5 text-center',
                            cell.passed
                              ? 'bg-green-50/50 dark:bg-green-950/10'
                              : regression
                                ? 'bg-yellow-50/50 dark:bg-yellow-950/10'
                                : 'bg-red-50/50 dark:bg-red-950/10'
                          )}
                        >
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center gap-1">
                              {cell.passed ? (
                                <CheckCircle className="w-4 h-4 text-green-500" />
                              ) : regression ? (
                                <AlertTriangle className="w-4 h-4 text-yellow-500" />
                              ) : (
                                <XCircle className="w-4 h-4 text-red-500" />
                              )}
                              <span className="text-xs font-mono">
                                {Math.round(cell.score * 100)}%
                              </span>
                            </div>
                            <span className="text-[10px] text-gray-400">
                              {cell.latencyMs > 1000
                                ? `${(cell.latencyMs / 1000).toFixed(1)}s`
                                : `${cell.latencyMs}ms`}
                            </span>
                            {regression && (
                              <span className="text-[10px] text-yellow-600 dark:text-yellow-400 font-medium">
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
            <GitCompare className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
            <p className="text-gray-500 dark:text-gray-400">Select at least 2 eval runs to compare</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
