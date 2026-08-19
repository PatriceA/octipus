'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Run trace — what ran, for how long, and what it cost.
 *
 * The bars are positioned from the same span windows the backend fold produces,
 * so this view never re-derives timing: if a bar looks wrong, the log is wrong.
 */
interface TraceSpan {
  id: string;
  subject: string;
  subjectId: string;
  name: string;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  status: 'running' | 'completed' | 'failed';
  open: boolean;
  costUsd: number;
  tokens: number;
  modelCalls: number;
}

interface RunTrace {
  runId: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  spans: TraceSpan[];
  totals: {
    costUsd: number;
    tokens: number;
    modelCalls: number;
    unattributedCostUsd: number;
    nodes: number;
    toolCalls: number;
  };
}

const money = (v: number) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
const duration = (ms: number | null) => {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

const BAR_COLOR: Record<string, string> = {
  running: 'bg-primary',
  completed: 'bg-success',
  failed: 'bg-error',
};

export default function TraceClient() {
  const router = useRouter();
  const runId = useSearchParams().get('id') ?? '';

  const { data: trace, isLoading } = useQuery({
    queryKey: ['run-trace', runId],
    queryFn: async () => {
      try {
        return await api.get<RunTrace>(`/runs/${runId}/trace`);
      } catch {
        return null;
      }
    },
    enabled: !!runId,
    // A live run keeps producing spans; a finished one settles and this is
    // cheap (one fold over an indexed read).
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  if (!trace || trace.spans.length === 0) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <div className="text-center py-12 font-mono">
          <span aria-hidden className="block text-lg text-outline mb-2">·</span>
          <span className="text-[12px] text-on-surface-variant">no trace for this run</span>
        </div>
      </div>
    );
  }

  const t0 = trace.startMs ?? 0;
  const total = Math.max(trace.durationMs ?? 1, 1);
  const nodes = trace.spans.filter((s) => s.subject !== 'tool');
  const tools = trace.spans.filter((s) => s.subject === 'tool');

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'duration', value: duration(trace.durationMs) },
          { label: 'cost', value: money(trace.totals.costUsd) },
          { label: 'tokens', value: trace.totals.tokens.toLocaleString() },
          { label: 'nodes', value: String(trace.totals.nodes) },
          { label: 'tool calls', value: String(trace.totals.toolCalls) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border border-outline/40 p-3">
            <div className="text-[10px] uppercase tracking-wide text-on-surface-variant">{stat.label}</div>
            <div className="text-lg font-mono">{stat.value}</div>
          </div>
        ))}
      </div>

      <section className="space-y-1">
        <h2 className="text-sm font-medium">Execution</h2>
        {nodes.map((span) => {
          const left = ((span.startMs - t0) / total) * 100;
          const width = Math.max((((span.endMs ?? span.startMs + 1) - span.startMs) / total) * 100, 0.5);
          return (
            <div key={span.id} className="grid grid-cols-[minmax(8rem,14rem)_1fr_auto] gap-3 items-center text-xs">
              <span className="truncate" title={span.name}>
                {span.name}
                {span.open && <span className="ml-1 text-primary">•</span>}
              </span>
              <span className="relative h-3 rounded bg-surface-variant/40">
                <span
                  className={cn('absolute h-3 rounded', BAR_COLOR[span.status] ?? 'bg-primary')}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${duration(span.durationMs)} · ${money(span.costUsd)}`}
                />
              </span>
              <span className="font-mono text-on-surface-variant whitespace-nowrap">
                {duration(span.durationMs)}
                {span.costUsd > 0 && ` · ${money(span.costUsd)}`}
              </span>
            </div>
          );
        })}
      </section>

      {tools.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-sm font-medium">Tool calls</h2>
          {/* Grouped: a run makes hundreds of these, and one row each is a log,
              not a dashboard. */}
          <div className="grid gap-1 text-xs font-mono">
            {Object.entries(
              tools.reduce<Record<string, { calls: number; ms: number; failed: number }>>((acc, s) => {
                const cur = acc[s.name] ?? { calls: 0, ms: 0, failed: 0 };
                cur.calls += 1;
                cur.ms += s.durationMs ?? 0;
                if (s.status === 'failed') cur.failed += 1;
                acc[s.name] = cur;
                return acc;
              }, {}),
            )
              .sort((a, b) => b[1].ms - a[1].ms)
              .map(([name, stat]) => (
                <div key={name} className="grid grid-cols-[1fr_auto_auto] gap-3">
                  <span className="truncate">{name}</span>
                  <span className="text-on-surface-variant">{stat.calls}×</span>
                  <span className={cn('w-20 text-right', stat.failed > 0 && 'text-error')}>
                    {duration(stat.ms)}
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}

      {trace.totals.unattributedCostUsd > 0 && (
        <p className="text-[11px] text-on-surface-variant">
          {money(trace.totals.unattributedCostUsd)} was billed outside any node — the session&apos;s own
          turns rather than pipeline work.
        </p>
      )}
    </div>
  );
}
