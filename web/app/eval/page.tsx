'use client';

import { BarChart3, CheckCircle, FlaskConical, GitCompare, Hash, Microscope, Play, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ConformanceTab } from '@/components/eval/ConformanceTab';
import { EvalCard } from '@/components/eval/EvalCard';
import { ModelEvalTab } from '@/components/eval/ModelEvalTab';
import { ScoreBar } from '@/components/eval/ScoreBar';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

type TabId = 'suite' | 'conformance' | 'model-eval';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'suite', label: 'Suite Tests', icon: <FlaskConical className="w-4 h-4" /> },
  { id: 'conformance', label: 'Conformance', icon: <ShieldCheck className="w-4 h-4" /> },
  { id: 'model-eval', label: 'Model Eval', icon: <Microscope className="w-4 h-4" /> },
];

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
  const [activeTab, setActiveTab] = useState<TabId>('suite');
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
  const [models, setModels] = useState<Array<{ id: string; name?: string; modelId?: string }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

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
      const body: { type: string; model?: string } = { type };
      if (selectedModel) body.model = selectedModel;
      const data = await api.post<{ runId: string; started: boolean; error?: string; running?: boolean }>('/eval/run', body);
      if (data.error) {
        setError(data.error);
        return;
      }
      setRunStatus({ running: true, runId: data.runId, type });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedModel]);

  // Fetch available models for the picker
  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<{ models: Array<{ id: string; name?: string; modelId?: string }> } | Array<{ id: string; name?: string; modelId?: string }>>('/models/');
        const list = Array.isArray(data) ? data : (data as { models: Array<{ id: string; name?: string; modelId?: string }> }).models ?? [];
        setModels(list);
      } catch {
        // Picker stays empty; the runner will fall back to the DB default or fail loud.
      }
    })();
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tighter text-white font-headline">Evaluations</h1>
            <p className="text-on-surface-variant">Test agent routing accuracy, tool usage, and response quality. Run evaluation suites and compare results across models.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchResults}
            className="px-3 py-2 border border-outline-variant/10 text-white/80 rounded-lg hover:bg-[#1a1a1a] cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {models.length > 0 && (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={runStatus.running}
              className="px-3 py-2 bg-[#1a1a1a] border border-outline-variant/10 text-white/80 rounded-lg text-sm cursor-pointer focus:outline-none focus:border-primary"
              title="Model to run evaluations against (defaults to the DB-configured default)"
            >
              <option value="">Default model</option>
              {models.map((m) => {
                const value = m.name || m.modelId || m.id;
                return <option key={m.id} value={value}>{m.name || m.modelId || m.id}</option>;
              })}
            </select>
          )}
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
              <div className="absolute right-0 top-full mt-1 bg-[#1a1a1a] border border-outline-variant/10 rounded-lg shadow-lg z-10 min-w-[160px]">
                <button
                  onClick={() => startEval('eval')}
                  className="w-full px-4 py-2 text-left text-sm text-white/80 hover:bg-[#1a1a1a] rounded-t-lg cursor-pointer"
                >
                  <FlaskConical className="w-4 h-4 inline mr-2" />
                  Standard Eval
                </button>
                <button
                  onClick={() => startEval('red-team')}
                  className="w-full px-4 py-2 text-left text-sm text-white/80 hover:bg-[#1a1a1a] rounded-b-lg cursor-pointer"
                >
                  <ShieldAlert className="w-4 h-4 inline mr-2" />
                  Red Team
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-outline-variant/10">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'text-white border-b-2 border-primary -mb-px'
                : 'text-on-surface-variant hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Conformance tab */}
      {activeTab === 'conformance' && <ConformanceTab />}

      {/* Model Eval tab */}
      {activeTab === 'model-eval' && <ModelEvalTab />}

      {/* Suite Tests tab (existing content) */}
      {activeTab === 'suite' && (
        <>
          {error && (
            <div className="bg-red-900/20 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
              {error}
              <button onClick={() => setError('')} className="ml-2 underline cursor-pointer">dismiss</button>
            </div>
          )}

          {/* Running status banner */}
          {runStatus.running && (
            <div className="bg-yellow-900/20 border border-yellow-800 rounded-xl px-4 py-3 text-yellow-300 text-sm">
              <div className="flex items-center gap-3">
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
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
                <pre className="mt-2 text-xs bg-black/30 rounded-lg p-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono">
                  {runStatus.output}
                </pre>
              )}
            </div>
          )}

          {/* Last run error banner */}
          {!runStatus.running && runStatus.lastRun && runStatus.lastRun.exitCode !== 0 && (
            <div className="bg-red-900/20 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
              <div className="flex items-center gap-3">
                <XCircle className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  <strong>{runStatus.lastRun.type === 'red-team' ? 'Red-team' : 'Evaluation'}</strong> failed
                  {runStatus.lastRun.exitCode !== null && <> (exit code {runStatus.lastRun.exitCode})</>}
                </span>
                <button onClick={() => setShowOutput(!showOutput)} className="underline text-xs cursor-pointer">
                  {showOutput ? 'hide' : 'show'} output
                </button>
              </div>
              {showOutput && runStatus.lastRun.output && (
                <pre className="mt-2 text-xs bg-black/30 rounded-lg p-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono">
                  {runStatus.lastRun.output}
                </pre>
              )}
            </div>
          )}

          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="w-10 h-10 rounded-lg bg-blue-950/30 flex items-center justify-center">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-white">{totalRuns}</p>
                  <p className="text-xs text-on-surface-variant">Total Runs</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="w-10 h-10 rounded-lg bg-green-950/30 flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-green-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-white">
                    {loading ? '—' : `${Math.round(avgPassRate * 100)}%`}
                  </p>
                  <p className="text-xs text-on-surface-variant">Avg Pass Rate</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="w-10 h-10 rounded-lg bg-purple-950/30 flex items-center justify-center">
                  <FlaskConical className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <ScoreBar score={avgScore} />
                  <p className="text-xs text-on-surface-variant mt-1">Avg Score</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="w-10 h-10 rounded-lg bg-orange-950/30 flex items-center justify-center">
                  <Hash className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-white">
                    {formatNumber(totalTests)}
                  </p>
                  <p className="text-xs text-on-surface-variant">Total Tests</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Quick links */}
          <div className="flex gap-3">
            <Link
              href="/eval/compare"
              className="flex items-center gap-2 px-4 py-2 border border-outline-variant/10 rounded-lg text-sm text-on-surface-variant hover:bg-[#1a1a1a] transition-colors"
            >
              <GitCompare className="w-4 h-4" />
              Compare Runs
            </Link>
            <Link
              href="/eval/red-team"
              className="flex items-center gap-2 px-4 py-2 border border-outline-variant/10 rounded-lg text-sm text-on-surface-variant hover:bg-[#1a1a1a] transition-colors"
            >
              <ShieldAlert className="w-4 h-4" />
              Red Team
            </Link>
          </div>

          {/* Results List */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-3">Recent Results</h2>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" />
              </div>
            ) : results.length === 0 ? (
              <Card>
                <CardContent className="text-center py-12">
                  <FlaskConical className="w-12 h-12 mx-auto mb-3 text-on-surface-variant" />
                  <p className="text-on-surface-variant">No evaluation results yet</p>
                  <p className="text-sm text-on-surface-variant mt-1">
                    Click &quot;Run Eval&quot; above or run from CLI: <code className="bg-[#262626] px-1.5 py-0.5 rounded text-xs">bun run src/eval/cli.ts</code>
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
        </>
      )}
    </div>
  );
}
