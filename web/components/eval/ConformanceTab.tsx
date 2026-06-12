'use client';

import { CheckCircle, ChevronDown, ChevronRight, Clock, Minus, Play, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ScoreBar } from './ScoreBar';

interface ConformanceResult {
  model: string;
  provider: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped';
  latencyMs?: number;
  error?: string;
}

interface ConformanceRun {
  id: string;
  models: string[];
  results: ConformanceResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  createdAt: string;
}

interface ModelInfo {
  id: string;
  name?: string;
}

function StatusCell({ status, latencyMs, error }: { status: 'passed' | 'failed' | 'skipped'; latencyMs?: number; error?: string }) {
  const [showTooltip, setShowTooltip] = useState(false);

  const icon =
    status === 'passed' ? <CheckCircle className="w-4 h-4 text-tertiary" /> :
    status === 'failed' ? <XCircle className="w-4 h-4 text-error" /> :
    <Minus className="w-4 h-4 text-on-surface-variant" />;

  const hasTooltip = latencyMs != null || error;

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => hasTooltip && setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {icon}
      {showTooltip && hasTooltip && (
        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-20 bg-surface-container border border-outline-variant/20 rounded-lg px-2.5 py-1.5 text-xs text-on-surface whitespace-nowrap shadow-lg">
          {latencyMs != null && (
            <div className="flex items-center gap-1 text-on-surface-variant">
              <Clock className="w-3 h-3" />
              {latencyMs}ms
            </div>
          )}
          {error && <div className="text-error max-w-[200px] whitespace-normal">{error}</div>}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: ConformanceRun }) {
  const [expanded, setExpanded] = useState(false);
  const passRate = run.summary.total > 0 ? run.summary.passed / run.summary.total : 0;

  // Build matrix for expanded view
  const models = Array.from(new Set(run.results.map(r => r.model)));
  const tests = Array.from(new Set(run.results.map(r => r.test)));
  const resultMap = new Map(run.results.map(r => [`${r.model}::${r.test}`, r]));

  return (
    <div className="border border-outline-variant/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-on-surface-variant shrink-0" /> : <ChevronRight className="w-4 h-4 text-on-surface-variant shrink-0" />}
        <span className="text-xs text-on-surface-variant shrink-0" suppressHydrationWarning>
          {formatDate(run.createdAt)}
        </span>
        <span className="text-xs text-on-surface-variant shrink-0">
          {run.models.length} model{run.models.length !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-3 ml-auto">
          <span className="text-xs text-tertiary">{run.summary.passed} passed</span>
          {run.summary.failed > 0 && <span className="text-xs text-error">{run.summary.failed} failed</span>}
          {run.summary.skipped > 0 && <span className="text-xs text-on-surface-variant">{run.summary.skipped} skipped</span>}
          <ScoreBar score={passRate} size="sm" />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 bg-[#111111] overflow-x-auto">
          <table className="w-full text-xs mt-3" style={{ minWidth: `${Math.max(400, tests.length * 120 + 160)}px` }}>
            <thead>
              <tr>
                <th className="text-left text-on-surface-variant font-medium py-2 pr-4 w-40">Model</th>
                {tests.map(test => (
                  <th key={test} className="text-center text-on-surface-variant font-medium py-2 px-2 max-w-[110px]">
                    <span className="block truncate" title={test}>{test}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map(model => (
                <tr key={model} className="border-t border-outline-variant/10">
                  <td className="py-2 pr-4 text-on-surface/80 font-mono truncate max-w-[160px]" title={model}>
                    {model}
                  </td>
                  {tests.map(test => {
                    const r = resultMap.get(`${model}::${test}`);
                    return (
                      <td key={test} className="py-2 px-2 text-center">
                        {r ? (
                          <StatusCell status={r.status} latencyMs={r.latencyMs} error={r.error} />
                        ) : (
                          <Minus className="w-4 h-4 text-outline-variant/30 mx-auto" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ConformanceTab() {
  const [runs, setRuns] = useState<ConformanceRun[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Close the model picker when the user clicks outside it. Without this
  // the dropdown sticks open until the toggle button is clicked again,
  // which the user flagged during QA.
  useEffect(() => {
    if (!showModelPicker) return;
    function onClick(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showModelPicker]);

  const fetchRuns = useCallback(async () => {
    try {
      const data = await api.get<{ runs: ConformanceRun[] }>('/evaluations/conformance/runs');
      setRuns(data.runs || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const data = await api.get<{ models: ModelInfo[] } | ModelInfo[]>('/models/');
      const list = Array.isArray(data) ? data : (data as { models: ModelInfo[] }).models ?? [];
      setModels(list);
    } catch {
      // Non-fatal — model picker just stays empty
    }
  }, []);

  // Poll for running jobs
  const checkStatus = useCallback(async () => {
    try {
      const data = await api.get<{ running: boolean; job?: { type: string; status: string } }>('/evaluations/status');
      if (data.running) {
        setRunning(true);
      } else if (running) {
        // Job just finished — refresh results
        setRunning(false);
        fetchRuns();
      }
    } catch { /* ignore */ }
  }, [running, fetchRuns]);

  useEffect(() => {
    fetchRuns();
    fetchModels();
    checkStatus();
  }, [fetchRuns, fetchModels, checkStatus]);

  // Poll while running
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  }, [running, checkStatus]);

  const runConformance = async () => {
    try {
      setRunning(true);
      setError('');
      const body: { models?: string[] } = {};
      if (selectedModels.length > 0) body.models = selectedModels;
      await api.post('/evaluations/conformance/run', body);
      // Don't await results — job runs in background, poll will pick it up
    } catch (err) {
      setRunning(false);
      setError((err as Error).message);
    }
  };

  const toggleModel = (id: string) => {
    setSelectedModels(prev =>
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    );
  };

  // Latest run matrix (top-level summary)
  const latest = runs[0];
  const latestModels = latest ? Array.from(new Set(latest.results.map(r => r.model))) : [];
  const latestTests = latest ? Array.from(new Set(latest.results.map(r => r.test))) : [];
  const latestMap = latest ? new Map(latest.results.map(r => [`${r.model}::${r.test}`, r])) : new Map();
  const latestPassRate = latest && latest.summary.total > 0
    ? latest.summary.passed / latest.summary.total
    : null;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative" ref={modelPickerRef}>
          <button
            onClick={() => setShowModelPicker(!showModelPicker)}
            className="px-4 py-2 border border-outline-variant/10 text-on-surface/80 rounded-lg hover:bg-surface-container text-sm flex items-center gap-2 cursor-pointer"
          >
            {selectedModels.length === 0 ? 'All models' : `${selectedModels.length} selected`}
            <ChevronDown className="w-3 h-3" />
          </button>
          {showModelPicker && models.length > 0 && (
            <div className="absolute top-full mt-1 left-0 z-20 bg-surface-container border border-outline-variant/10 rounded-xl shadow-lg min-w-[220px] max-h-60 overflow-y-auto">
              {models.map(m => {
                const id = m.name || (m as any).modelId || m.id;
                const label = m.name || (m as any).modelId || m.id;
                return (
                  <label key={id} className="flex items-center gap-2 px-4 py-2 hover:bg-[#222] cursor-pointer text-sm text-on-surface/80">
                    <input
                      type="checkbox"
                      checked={selectedModels.includes(id)}
                      onChange={() => toggleModel(id)}
                      className="rounded"
                    />
                    <span className="truncate">{label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={runConformance}
          disabled={running}
          className={`px-4 py-2 rounded-lg flex items-center gap-2 text-sm cursor-pointer ${
            running ? 'bg-warning text-on-warning' : 'bg-primary text-on-surface hover:bg-primary-dim'
          }`}
        >
          {running ? (
            <><RefreshCw className="w-4 h-4 animate-spin" /> Running...</>
          ) : (
            <><Play className="w-4 h-4" /> Run Conformance</>
          )}
        </button>

        <button
          onClick={fetchRuns}
          className="px-3 py-2 border border-outline-variant/10 text-on-surface/80 rounded-lg hover:bg-surface-container cursor-pointer"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="bg-error-container/60 border border-error/40 rounded-xl px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline cursor-pointer">dismiss</button>
        </div>
      )}

      {/* Latest run matrix */}
      {latest && (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-on-surface">Latest Run</h3>
                <p className="text-xs text-on-surface-variant mt-0.5" suppressHydrationWarning>
                  {formatDate(latest.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-tertiary flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> {latest.summary.passed}
                  </span>
                  <span className="text-error flex items-center gap-1">
                    <XCircle className="w-3 h-3" /> {latest.summary.failed}
                  </span>
                  {latest.summary.skipped > 0 && (
                    <span className="text-on-surface-variant flex items-center gap-1">
                      <Minus className="w-3 h-3" /> {latest.summary.skipped}
                    </span>
                  )}
                </div>
                {latestPassRate !== null && <ScoreBar score={latestPassRate} />}
              </div>
            </div>

            {latestModels.length > 0 && latestTests.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs" style={{ minWidth: `${Math.max(400, latestTests.length * 110 + 160)}px` }}>
                  <thead>
                    <tr>
                      <th className="text-left text-on-surface-variant font-medium py-2 pr-4 w-40">Model</th>
                      {latestTests.map(test => (
                        <th key={test} className="text-center text-on-surface-variant font-medium py-2 px-2 max-w-[100px]">
                          <span className="block truncate" title={test}>{test}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {latestModels.map(model => (
                      <tr key={model} className="border-t border-outline-variant/10">
                        <td className="py-2 pr-4 text-on-surface/80 font-mono truncate max-w-[160px]" title={model}>
                          {model}
                        </td>
                        {latestTests.map(test => {
                          const r = latestMap.get(`${model}::${test}`);
                          return (
                            <td key={test} className="py-2 px-2 text-center">
                              {r ? (
                                <StatusCell status={r.status} latencyMs={r.latencyMs} error={r.error} />
                              ) : (
                                <Minus className="w-4 h-4 text-outline-variant/30 mx-auto" />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Historical runs */}
      <div>
        <h2 className="text-sm font-semibold text-on-surface mb-3">Run History</h2>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw className="w-5 h-5 animate-spin text-on-surface-variant" />
          </div>
        ) : runs.length === 0 ? (
          <Card>
            <CardContent className="text-center py-10">
              <CheckCircle className="w-10 h-10 mx-auto mb-2 text-on-surface-variant" />
              <p className="text-on-surface-variant text-sm">No conformance runs yet</p>
              <p className="text-xs text-on-surface-variant mt-1">Click &quot;Run Conformance&quot; above to start.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {runs.map(run => <RunRow key={run.id} run={run} />)}
          </div>
        )}
      </div>
    </div>
  );
}
