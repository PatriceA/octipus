'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { FlaskConical, RefreshCw, Play, BarChart3, CheckCircle, XCircle, Hash, GitCompare, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { EvalCard } from '@/components/eval/EvalCard';
import { ScoreBar } from '@/components/eval/ScoreBar';

interface EvalSuiteSummary {
  suite: string;
  totalTests: number;
  passed: number;
  failed: number;
  score: number;
  duration: number;
  timestamp: string;
}

interface EvalListItem {
  id: string;
  filename: string;
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

export default function EvalPage() {
  const [results, setResults] = useState<EvalListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchResults = useCallback(async () => {
    try {
      const data = await api.get<{ results: EvalListItem[] }>('/eval/results');
      setResults(data.results || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Aggregate stats
  const totalRuns = results.length;
  const avgPassRate = totalRuns > 0
    ? results.reduce((s, r) => s + (r.summary.totalTests > 0 ? r.summary.totalPassed / r.summary.totalTests : 0), 0) / totalRuns
    : 0;
  const avgScore = totalRuns > 0
    ? results.reduce((s, r) => s + r.summary.averageScore, 0) / totalRuns
    : 0;
  const totalTests = results.reduce((s, r) => s + r.summary.totalTests, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-primary-700 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Evaluations</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Agent evaluation results and analysis</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchResults}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              // Future: trigger eval run from UI
              alert('Run eval via CLI: bun run src/eval/cli.ts');
            }}
            className="px-4 py-2 bg-primary-800 text-white cursor-pointer rounded-lg hover:bg-primary-900 flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            Run Eval
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline cursor-pointer">dismiss</button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-950/30 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{totalRuns}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Runs</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-950/30 flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {Math.round(avgPassRate * 100)}%
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Avg Pass Rate</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-950/30 flex items-center justify-center">
              <FlaskConical className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <ScoreBar score={avgScore} />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Avg Score</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 rounded-lg bg-orange-100 dark:bg-orange-950/30 flex items-center justify-center">
              <Hash className="w-5 h-5 text-orange-600 dark:text-orange-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {formatNumber(totalTests)}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Tests</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick links */}
      <div className="flex gap-3">
        <Link
          href="/eval/compare"
          className="flex items-center gap-2 px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <GitCompare className="w-4 h-4" />
          Compare Runs
        </Link>
        <Link
          href="/eval/red-team"
          className="flex items-center gap-2 px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <ShieldAlert className="w-4 h-4" />
          Red Team
        </Link>
      </div>

      {/* Results List */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Recent Results</h2>
        {results.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <FlaskConical className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
              <p className="text-gray-500 dark:text-gray-400">No evaluation results yet</p>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
                Run an eval suite: <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">bun run src/eval/cli.ts</code>
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((result) => (
              <EvalCard
                key={result.id}
                id={result.id}
                timestamp={result.timestamp}
                summary={result.summary}
                suites={result.suites}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
