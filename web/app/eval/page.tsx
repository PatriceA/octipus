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
    averageScore?: number;
    passRate?: number;
  };
  suites: EvalSuiteSummary[];
}

export default function EvalPage() {
  const [results, setResults] = useState<EvalListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runStatus, setRunStatus] = useState<{
    running: boolean;
    runId?: string;
    type?: string;
    suite?: string;
    elapsedMs?: number;
    output?: string;
    lastRun?: { runId: string; type: string; suite: string; exitCode: number | null; output: string };
  }>({ running: false });
  const [showRunMenu, setShowRunMenu] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

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

  const checkStatus = useCallback(async () => {
    try {
      const data = await api.get<{
        running: boolean;
        runId?: string;
        type?: string;
        suite?: string;
        elapsedMs?: number;
        output?: string;
        lastRun?: { runId: string; type: string; suite: string; exitCode: number | null; output: string };
      }>('/eval/status');
      const wasRunning = runStatus.running;
      setRunStatus(data);
      if (!data.running && wasRunning) {
        // Eval just finished — refresh results and show output if it failed
        fetchResults();
        if (data.lastRun?.exitCode !== 0) {
          setShowOutput(true);
        }
      }
      return data.running;
    } catch {
      return false;
    }
  }, [runStatus.running, fetchResults]);

  const startEval = useCallback(async (type: 'eval' | 'red-team') => {
    try {
      setShowRunMenu(false);
      const data = await api.post<{ runId: string; started: boolean; error?: string; running?: boolean }>('/eval/run', { type });
      if (data.error) {
        setError(data.error);
        return;
      }
      setRunStatus({ running: true, runId: data.runId, type });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Poll status while an eval is running
  useEffect(() => {
    if (!runStatus.running) return;
    const interval = setInterval(async () => {
      const stillRunning = await checkStatus();
      if (!stillRunning) clearInterval(interval);
    }, 3000);
    return () => clearInterval(interval);
  }, [runStatus.running, checkStatus]);

  // Check if something is already running on mount
  useEffect(() => {
    checkStatus();
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
    ? results.reduce((s, r) => s + (r.summary.passRate ?? r.summary.averageScore ?? 0), 0) / totalRuns
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
          <div className="relative">
            <button
              onClick={() => runStatus.running ? null : setShowRunMenu(!showRunMenu)}
              disabled={runStatus.running}
              className={`px-4 py-2 rounded-lg flex items-center gap-2 cursor-pointer ${
                runStatus.running
                  ? 'bg-yellow-600 text-white'
                  : 'bg-primary-800 text-white hover:bg-primary-900'
              }`}
            >
              {runStatus.running ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Running {runStatus.type}...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Run Eval
                </>
              )}
            </button>
            {showRunMenu && !runStatus.running && (
              <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 min-w-[160px]">
                <button
                  onClick={() => startEval('eval')}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-t-lg cursor-pointer"
                >
                  <FlaskConical className="w-4 h-4 inline mr-2" />
                  Standard Eval
                </button>
                <button
                  onClick={() => startEval('red-team')}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-b-lg cursor-pointer"
                >
                  <ShieldAlert className="w-4 h-4 inline mr-2" />
                  Red Team
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline cursor-pointer">dismiss</button>
        </div>
      )}

      {/* Running status banner */}
      {runStatus.running && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl px-4 py-3 text-yellow-700 dark:text-yellow-300 text-sm">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" />
            <span className="flex-1">
              <strong>{runStatus.type === 'red-team' ? 'Red-team' : 'Evaluation'}</strong> running
              {runStatus.suite && runStatus.suite !== 'all' && <> (suite: {runStatus.suite})</>}
              {runStatus.elapsedMs && <> — {Math.round(runStatus.elapsedMs / 1000)}s elapsed</>}
            </span>
            {runStatus.output && (
              <button onClick={() => setShowOutput(!showOutput)} className="underline text-xs cursor-pointer">
                {showOutput ? 'hide' : 'show'} output
              </button>
            )}
          </div>
          {showOutput && runStatus.output && (
            <pre className="mt-2 text-xs bg-black/10 dark:bg-black/30 rounded-lg p-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono">
              {runStatus.output}
            </pre>
          )}
        </div>
      )}

      {/* Last run error banner */}
      {!runStatus.running && runStatus.lastRun && runStatus.lastRun.exitCode !== 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
          <div className="flex items-center gap-3">
            <XCircle className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">
              <strong>{runStatus.lastRun.type === 'red-team' ? 'Red-team' : 'Evaluation'}</strong> failed
              {runStatus.lastRun.exitCode !== null && <> (exit code {runStatus.lastRun.exitCode})</>}
            </span>
            <button onClick={() => setShowOutput(!showOutput)} className="underline text-xs cursor-pointer">
              {showOutput ? 'hide' : 'show'} output
            </button>
          </div>
          {showOutput && runStatus.lastRun.output && (
            <pre className="mt-2 text-xs bg-black/10 dark:bg-black/30 rounded-lg p-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono">
              {runStatus.lastRun.output}
            </pre>
          )}
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
