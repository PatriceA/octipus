'use client';

import { BarChart3, CheckCircle, ChevronDown, ChevronRight, Database, Layers, Play, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ScoreBar } from './ScoreBar';

interface Dataset {
  name: string;
  description: string;
  count: number;
}

interface Evaluator {
  name: string;
  description: string;
}

interface EvalRun {
  id: string;
  model: string;
  dataset?: string;
  evaluators?: string[];
  scores?: Record<string, { mean: number; passRate: number; count: number }>;
  samples?: EvalSample[];
  createdAt: string;
  status?: string;
}

interface EvalSample {
  id?: string;
  input?: string;
  output?: string;
  evaluator?: string;
  score?: number;
  passed?: boolean;
  reasoning?: string;
}

interface SummaryData {
  [model: string]: {
    [evaluator: string]: { mean: number; passRate: number; count: number };
  };
}

interface ModelInfo {
  id: string;
  name?: string;
  modelId?: string;
}

// Score cell with color intensity
function ScoreCell({ value }: { value: { mean: number; passRate: number; count: number } | undefined }) {
  if (!value) return <td className="py-2 px-3 text-center text-on-surface-variant text-xs">—</td>;
  const pct = Math.round(value.mean * 100);
  const textColor =
    pct >= 80 ? 'text-green-400' :
    pct >= 50 ? 'text-yellow-400' :
    'text-error';
  return (
    <td className="py-2 px-3 text-center">
      <span className={`text-sm font-mono font-semibold ${textColor}`}>{pct}%</span>
      <div className="text-xs text-on-surface-variant">{Math.round(value.passRate * 100)}% pass</div>
    </td>
  );
}

interface EvalResultItem {
  dataPointId: string;
  input: string;
  output: string;
  reference?: string;
  scores: Array<{ metric: string; score: number; status: string; reasoning?: string }>;
  timestamp?: string;
}

function ResultsDetail({ results }: { results: EvalResultItem[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div className="mt-3 space-y-2 max-h-[500px] overflow-y-auto">
      {results.map((r, i) => (
        <div key={r.dataPointId ?? i} className="bg-[#111] border border-outline-variant/10 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[#1a1a1a] cursor-pointer text-left"
          >
            {expandedIdx === i ? <ChevronDown className="w-3 h-3 text-on-surface-variant shrink-0" /> : <ChevronRight className="w-3 h-3 text-on-surface-variant shrink-0" />}
            <span className="text-xs text-white/80 truncate flex-1">{r.input}</span>
            <div className="flex items-center gap-1 shrink-0">
              {r.scores.filter(s => s.status !== 'UNKNOWN').map(s => (
                <span key={s.metric} className={`text-[10px] px-1.5 py-0.5 rounded ${
                  s.status === 'PASS' ? 'bg-green-900/30 text-green-400' :
                  s.status === 'FAIL' ? 'bg-red-900/30 text-error' :
                  'bg-gray-900/30 text-gray-400'
                }`}>
                  {s.metric.slice(0, 3)} {Math.round(s.score * 100)}%
                </span>
              ))}
            </div>
          </button>
          {expandedIdx === i && (
            <div className="px-3 pb-3 space-y-2 text-xs border-t border-outline-variant/10">
              <div className="mt-2">
                <span className="text-on-surface-variant font-medium">Question:</span>
                <p className="text-white/80 mt-0.5 whitespace-pre-wrap">{r.input}</p>
              </div>
              <div>
                <span className="text-on-surface-variant font-medium">Model Answer:</span>
                <p className="text-white/80 mt-0.5 whitespace-pre-wrap max-h-40 overflow-y-auto">{r.output || '(empty)'}</p>
              </div>
              {r.reference && (
                <div>
                  <span className="text-on-surface-variant font-medium">Expected/Reference:</span>
                  <p className="text-blue-300/80 mt-0.5 whitespace-pre-wrap">{r.reference}</p>
                </div>
              )}
              <div className="space-y-1.5 mt-2">
                <span className="text-on-surface-variant font-medium">Scores:</span>
                {r.scores.filter(s => s.status !== 'UNKNOWN').map(s => (
                  <div key={s.metric} className="flex items-start gap-2 bg-[#0a0a0a] rounded p-2">
                    <div className="flex items-center gap-2 min-w-[140px] shrink-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        s.status === 'PASS' ? 'bg-green-500' : s.status === 'FAIL' ? 'bg-red-500' : 'bg-gray-500'
                      }`} />
                      <span className="text-white/70">{s.metric}</span>
                      <ScoreBar score={s.score} size="sm" />
                    </div>
                    {s.reasoning && (
                      <span className="text-on-surface-variant italic flex-1">{s.reasoning}</span>
                    )}
                  </div>
                ))}
                {r.scores.some(s => s.status === 'UNKNOWN') && (
                  <p className="text-[10px] text-on-surface-variant mt-1">
                    Skipped: {r.scores.filter(s => s.status === 'UNKNOWN').map(s => s.metric).join(', ')} (not applicable to this dataset)
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Legacy DrillDown for backward compat
function DrillDown({ samples }: { samples: EvalSample[] }) {
  const mapped: EvalResultItem[] = samples.map(s => ({
    dataPointId: s.id ?? '',
    input: s.input ?? '',
    output: s.output ?? '',
    scores: [{ metric: s.evaluator ?? '', score: s.score ?? 0, status: (s.passed ? 'PASS' : 'FAIL'), reasoning: s.reasoning }],
  }));
  return <ResultsDetail results={mapped} />;
}

function RunHistoryRow({ run }: { run: EvalRun }) {
  const [expanded, setExpanded] = useState(false);
  const scores = run.scores ?? (run as any).summary ?? {};
  const evaluatorKeys = Object.keys(scores);

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
        <span className="text-sm text-white/80 font-mono truncate flex-1 text-left">{run.model}</span>
        {run.dataset && (
          <span className="text-xs text-on-surface-variant shrink-0">{run.dataset}</span>
        )}
        {evaluatorKeys.length > 0 && (
          <div className="flex items-center gap-2 ml-auto shrink-0">
            {evaluatorKeys.slice(0, 3).map(k => (
              <ScoreBar key={k} score={scores[k].mean} size="sm" showLabel={false} />
            ))}
            {evaluatorKeys.length > 3 && (
              <span className="text-xs text-on-surface-variant">+{evaluatorKeys.length - 3}</span>
            )}
          </div>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 bg-[#111111]">
          {evaluatorKeys.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mt-3">
              {evaluatorKeys.map(k => (
                <div key={k} className="bg-[#1a1a1a] rounded-lg p-3 border border-outline-variant/10">
                  <p className="text-xs text-on-surface-variant mb-1.5 truncate" title={k}>{k}</p>
                  <ScoreBar score={scores[k].mean} />
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-on-surface-variant">
                    <span>{Math.round(scores[k].passRate * 100)}% pass</span>
                    <span>{scores[k].count} samples</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(run as any).results && (run as any).results.length > 0 && (
            <>
              <p className="text-xs text-on-surface-variant mt-4 mb-2 font-medium">Detailed Results</p>
              <ResultsDetail results={(run as any).results} />
            </>
          )}
          {run.samples && run.samples.length > 0 && !(run as any).results && (
            <>
              <p className="text-xs text-on-surface-variant mt-4 mb-2 font-medium">Sample Results</p>
              <DrillDown samples={run.samples} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ModelEvalTab() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [summary, setSummary] = useState<SummaryData>({});

  const [selectedModel, setSelectedModel] = useState('');
  const [selectedDataset, setSelectedDataset] = useState('');
  const [selectedEvaluators, setSelectedEvaluators] = useState<string[]>([]);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Drill-down state: { runId, evaluator }
  const [drillTarget, setDrillTarget] = useState<{ runId: string; evaluator: string } | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [datasetsRes, evaluatorsRes, runsRes, summaryRes] = await Promise.allSettled([
        api.get<{ datasets: Dataset[] }>('/evaluations/eval/datasets'),
        api.get<{ evaluators: Evaluator[] }>('/evaluations/eval/evaluators'),
        api.get<{ runs: EvalRun[] }>('/evaluations/eval/runs'),
        api.get<{ summary: SummaryData }>('/evaluations/eval/summary'),
      ]);
      if (datasetsRes.status === 'fulfilled') setDatasets(datasetsRes.value.datasets ?? []);
      if (evaluatorsRes.status === 'fulfilled') setEvaluators(evaluatorsRes.value.evaluators ?? []);
      if (runsRes.status === 'fulfilled') setRuns(runsRes.value.runs ?? []);
      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value.summary ?? {});
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
      if (list.length > 0 && !selectedModel) setSelectedModel(list[0].name || list[0].modelId || list[0].id);
    } catch {
      // Non-fatal
    }
  }, [selectedModel]);

  // Poll for running jobs
  const checkStatus = useCallback(async () => {
    try {
      const data = await api.get<{ running: boolean; job?: { type: string; status: string } }>('/evaluations/status');
      if (data.running) {
        setRunning(true);
      } else if (running) {
        setRunning(false);
        fetchAll();
      }
    } catch { /* ignore */ }
  }, [running, fetchAll]);

  useEffect(() => {
    fetchAll();
    fetchModels();
    checkStatus();
  }, [fetchAll, fetchModels, checkStatus]);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  }, [running, checkStatus]);

  const runEval = async () => {
    if (!selectedModel) return;
    try {
      setRunning(true);
      setError('');
      const body: { model: string; dataset?: string; evaluators?: string[] } = { model: selectedModel };
      if (selectedDataset) body.dataset = selectedDataset;
      if (selectedEvaluators.length > 0) body.evaluators = selectedEvaluators;
      await api.post('/evaluations/eval/run', body);
      // Job runs in background — poll will pick up completion
    } catch (err) {
      setRunning(false);
      setError((err as Error).message);
    }
  };

  const toggleEvaluator = (name: string) => {
    setSelectedEvaluators(prev =>
      prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]
    );
  };

  const summaryModels = Object.keys(summary);
  const summaryEvaluators = summaryModels.length > 0
    ? Array.from(new Set(summaryModels.flatMap(m => Object.keys(summary[m]))))
    : [];

  // Drill-down sample data (from run)
  const drillRun = drillTarget ? runs.find(r => r.id === drillTarget.runId) : null;
  const drillSamples = drillRun?.samples?.filter(s => !drillTarget?.evaluator || s.evaluator === drillTarget.evaluator) ?? [];

  return (
    <div className="space-y-6">
      {/* Run section */}
      <Card>
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Run Evaluation</h3>
          <div className="flex flex-wrap items-start gap-4">
            {/* Model selector */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-on-surface-variant">Model</label>
              <select
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                className="bg-[#1a1a1a] border border-outline-variant/10 rounded-lg px-3 py-2 text-sm text-white min-w-[200px] cursor-pointer"
              >
                {models.length === 0 && <option value="">No models available</option>}
                {models.map(m => (
                  <option key={m.id} value={m.name || m.modelId || m.id}>{m.name || m.modelId || m.id}</option>
                ))}
              </select>
            </div>

            {/* Dataset selector */}
            {datasets.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-on-surface-variant">Dataset</label>
                <select
                  value={selectedDataset}
                  onChange={e => setSelectedDataset(e.target.value)}
                  className="bg-[#1a1a1a] border border-outline-variant/10 rounded-lg px-3 py-2 text-sm text-white min-w-[180px] cursor-pointer"
                >
                  <option value="">Default dataset</option>
                  {datasets.map(d => (
                    <option key={d.name} value={d.name} title={d.description}>
                      {d.name} ({d.count})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Evaluator checkboxes */}
            {evaluators.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-on-surface-variant">Evaluators</label>
                <div className="flex flex-wrap gap-2">
                  {evaluators.map(e => (
                    <label
                      key={e.name}
                      className="flex items-center gap-1.5 text-sm text-white/80 cursor-pointer"
                      title={e.description}
                    >
                      <input
                        type="checkbox"
                        checked={selectedEvaluators.includes(e.name)}
                        onChange={() => toggleEvaluator(e.name)}
                        className="rounded"
                      />
                      {e.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-end pb-0.5">
              <button
                onClick={runEval}
                disabled={running || !selectedModel}
                className={`px-4 py-2 rounded-lg flex items-center gap-2 text-sm cursor-pointer ${
                  running ? 'bg-yellow-600 text-white' :
                  !selectedModel ? 'bg-[#1a1a1a] text-on-surface-variant cursor-not-allowed' :
                  'bg-primary text-white hover:bg-primary-dim'
                }`}
              >
                {running ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Running...</>
                ) : (
                  <><Play className="w-4 h-4" /> Run Evaluation</>
                )}
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline cursor-pointer">dismiss</button>
        </div>
      )}

      {/* Score cards for latest run */}
      {runs.length > 0 && runs[0].scores && Object.keys(runs[0].scores).length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Latest Run — {runs[0].model}</h2>
            <span className="text-xs text-on-surface-variant" suppressHydrationWarning>{formatDate(runs[0].createdAt)}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {Object.entries(runs[0].scores).map(([name, score]) => (
              <Card
                key={name}
                hover={!!(runs[0].samples?.some(s => s.evaluator === name))}
                className="cursor-pointer"
              >
                <CardContent className="p-4">
                <div
                  onClick={() => {
                    if (runs[0].samples?.some(s => s.evaluator === name)) {
                      setDrillTarget(
                        drillTarget?.runId === runs[0].id && drillTarget?.evaluator === name
                          ? null
                          : { runId: runs[0].id, evaluator: name }
                      );
                    }
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="w-8 h-8 rounded-lg bg-blue-950/30 flex items-center justify-center">
                      <BarChart3 className="w-4 h-4 text-blue-400" />
                    </div>
                    <ScoreBar score={score.mean} size="sm" />
                  </div>
                  <p className="text-sm font-medium text-white truncate" title={name}>{name}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-on-surface-variant">
                    <span className="flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      {Math.round(score.passRate * 100)}% pass
                    </span>
                    <span className="flex items-center gap-1">
                      <Database className="w-3 h-3" />
                      {score.count}
                    </span>
                  </div>
                </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Drill-down panel */}
          {drillTarget?.runId === runs[0].id && drillSamples.length > 0 && (
            <div className="mt-3 bg-[#1a1a1a] border border-outline-variant/10 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-white">{drillTarget.evaluator} — Sample Results</p>
                <button onClick={() => setDrillTarget(null)} className="text-xs text-on-surface-variant underline cursor-pointer">close</button>
              </div>
              <DrillDown samples={drillSamples} />
            </div>
          )}
        </div>
      )}

      {/* Cross-model comparison table */}
      {summaryModels.length > 0 && summaryEvaluators.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-4 h-4 text-on-surface-variant" />
            <h2 className="text-sm font-semibold text-white">Cross-Model Comparison</h2>
          </div>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs" style={{ minWidth: `${Math.max(400, summaryEvaluators.length * 130 + 180)}px` }}>
                <thead>
                  <tr className="border-b border-outline-variant/10">
                    <th className="text-left text-on-surface-variant font-medium py-3 px-4 w-44">Model</th>
                    {summaryEvaluators.map(e => (
                      <th key={e} className="text-center text-on-surface-variant font-medium py-3 px-3 max-w-[120px]">
                        <span className="block truncate" title={e}>{e}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaryModels.map((model, i) => (
                    <tr key={model} className={i > 0 ? 'border-t border-outline-variant/10' : ''}>
                      <td className="py-2 px-4 text-white/80 font-mono truncate max-w-[176px]" title={model}>
                        {model}
                      </td>
                      {summaryEvaluators.map(e => (
                        <ScoreCell key={e} value={summary[model]?.[e]} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Historical runs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white">Run History</h2>
          <button
            onClick={fetchAll}
            className="px-3 py-1.5 border border-outline-variant/10 text-white/80 rounded-lg hover:bg-[#1a1a1a] cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw className="w-5 h-5 animate-spin text-on-surface-variant" />
          </div>
        ) : runs.length === 0 ? (
          <Card>
            <CardContent className="text-center py-10">
              <BarChart3 className="w-10 h-10 mx-auto mb-2 text-on-surface-variant" />
              <p className="text-on-surface-variant text-sm">No evaluation runs yet</p>
              <p className="text-xs text-on-surface-variant mt-1">Configure and run an evaluation above.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {runs.map(run => <RunHistoryRow key={run.id} run={run} />)}
          </div>
        )}
      </div>
    </div>
  );
}
