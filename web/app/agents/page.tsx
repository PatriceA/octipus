'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Square } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusVariant } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceId } from '@/lib/workspace-context';
import {
  AGENT_SOURCE_LABEL,
  AGENT_SOURCES,
  type AgentSource,
  type MissionControlResponse,
  type MissionRun,
} from '../../../src/shared/agent-origin';

/** One colour per source, from the Deep Sea tokens; used as a dot and a chip border. */
const SOURCE_COLOR: Record<AgentSource | 'unknown', { dot: string; chip: string }> = {
  chat: { dot: 'bg-primary', chip: 'border-primary/50 text-primary' },
  spawned: { dot: 'bg-secondary', chip: 'border-secondary/50 text-secondary' },
  heartbeat: { dot: 'bg-tertiary', chip: 'border-tertiary/50 text-tertiary' },
  schedule: { dot: 'bg-warning', chip: 'border-warning/50 text-warning' },
  webhook: { dot: 'bg-accent', chip: 'border-accent/50 text-accent' },
  pipeline: { dot: 'bg-secondary-dim', chip: 'border-secondary-dim/50 text-secondary-dim' },
  companion: { dot: 'bg-primary-dim', chip: 'border-primary-dim/50 text-primary-dim' },
  monitor: { dot: 'bg-primary-dim', chip: 'border-primary-dim/50 text-primary-dim' },
  channel: { dot: 'bg-outline', chip: 'border-outline/60 text-on-surface-variant' },
  room: { dot: 'bg-outline', chip: 'border-outline/60 text-on-surface-variant' },
  manual: { dot: 'bg-outline', chip: 'border-outline/60 text-on-surface-variant' },
  unknown: { dot: 'bg-outline-variant', chip: 'border-outline-variant text-on-surface-variant' },
};

const STATUS_VARIANT: Record<MissionRun['status'], StatusVariant> = {
  running: 'success', idle: 'neutral', paused: 'warning', stopped: 'neutral', completed: 'info', failed: 'danger',
};

function sourceOf(run: MissionRun): AgentSource | 'unknown' {
  return run.origin?.source ?? 'unknown';
}

function sourceLabel(source: AgentSource | 'unknown'): string {
  return source === 'unknown' ? 'Not recorded' : AGENT_SOURCE_LABEL[source];
}

/** What the "Started by" chip adds after the source: the hook, the goal, the parent. */
function sourceDetail(run: MissionRun, byId: Map<string, MissionRun>): string | null {
  const o = run.origin;
  if (!o) return null;
  if (o.source === 'spawned' && run.parentAgentId) {
    const parent = byId.get(run.parentAgentId);
    return parent ? `by ${parent.root ? 'Octipus' : parent.role}` : 'by another agent';
  }
  if (o.hookName) return o.hookName;
  if (o.source === 'channel' && o.channel) return o.channel;
  return null;
}

function duration(ms: number | null, startedAt: string, running: boolean): string {
  const value = running ? Date.now() - new Date(startedAt).getTime() : ms;
  if (value === null || !Number.isFinite(value)) return '—';
  const s = Math.max(0, Math.round(value / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

function cost(usd: number | null): string {
  if (usd === null) return 'not recorded';
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isMissionControl(value: unknown): value is MissionControlResponse {
  const v = value as Partial<MissionControlResponse> | null;
  return !!v && Array.isArray(v.runs) && !!v.counts && Array.isArray(v.upcoming);
}

export default function MissionControlPage() {
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<AgentSource | 'unknown' | 'all'>('all');
  const [stopError, setStopError] = useState('');
  const { data, isError, isFetching, errorUpdatedAt, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['mission-control', workspaceId],
    queryFn: async () => {
      const response = await api.get<unknown>('/agents/overview');
      if (!isMissionControl(response)) throw new Error('The server returned data this version of the app cannot read.');
      return response;
    },
    refetchInterval: 5000,
  });
  const unavailable = isError || errorUpdatedAt > dataUpdatedAt;

  const runs = data?.runs ?? [];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const live = runs.filter((r) => r.status === 'running');
  const shown = filter === 'all' ? runs : runs.filter((r) => sourceOf(r) === filter);
  const sources = (['unknown', ...AGENT_SOURCES] as const).filter((s) => (data?.counts.bySource[s] ?? 0) > 0);

  async function stop(id: string) {
    setStopError('');
    try {
      await api.post(`/agents/${encodeURIComponent(id)}/stop`);
      await queryClient.invalidateQueries({ queryKey: ['mission-control'] });
    } catch (e) {
      setStopError(e instanceof Error ? `Could not stop the agent: ${e.message}` : 'Could not stop the agent');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mission control"
        description="Every agent working for you today, whoever started it: you in chat, another agent, the heartbeat, a schedule, a webhook, a pipeline or Companion."
        actions={<Link href="/agents/history" className="rounded-lg border border-outline-variant px-3 py-2 text-sm text-on-surface hover:bg-surface-container">Run history</Link>}
      />

      {unavailable && <div role="status" className="flex items-center gap-2 text-sm text-warning">
        {data ? 'Update failed; showing the last loaded state.' : 'Mission control could not be loaded.'}
        <button type="button" disabled={isFetching} onClick={() => void refetch()} className="inline-flex items-center gap-1 underline disabled:opacity-60"><RefreshCw size={14} />Retry</button>
      </div>}
      {!data && !unavailable && <p className="text-sm text-on-surface-variant">Loading…</p>}

      {data && <>
        <section aria-label="Today at a glance" className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <Tile label="Working now" value={String(data.counts.live)} detail={live.length ? summarizeSources(live) : 'Nothing running'} live={data.counts.live > 0} />
          <Tile label="Needs you" value={data.pendingApprovals === null ? '—' : String(data.pendingApprovals)}
            detail={data.pendingApprovals === null ? 'Approvals could not be read' : data.pendingApprovals ? 'Approvals waiting in chat' : 'No approvals waiting'}
            tone={data.pendingApprovals ? 'accent' : undefined} />
          <Tile label="Runs today" value={String(data.counts.today)} detail={data.counts.failedToday ? `${data.counts.failedToday} failed` : 'None failed'} />
          <Tile label="Recorded spend today" value={`$${data.spendTodayUsd.toFixed(2)}`} detail="Requests without a price are not included" />
        </section>

        <div className="flex flex-wrap items-start gap-6">
          <section aria-labelledby="live-h" className="min-w-0 flex-[2_1_520px] space-y-3">
            <h2 id="live-h" className="text-base font-semibold">Working now</h2>
            {stopError && <p role="alert" className="text-sm text-error">{stopError}</p>}
            {live.length === 0 && <p className="rounded-lg border border-outline-variant/60 bg-surface-container p-4 text-sm text-on-surface-variant">No agent is running. Runs started by schedules, the heartbeat and webhooks appear here while they work.</p>}
            {live.map((run) => <article key={run.id} className="space-y-3 rounded-lg border border-outline-variant/60 bg-surface-container p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-container text-sm font-bold text-primary">{run.root ? 'O' : run.role.slice(0, 2)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{run.root ? 'Octipus' : run.role}</span>
                    <StatusBadge variant="success" dot pulse>running</StatusBadge>
                    <span className="font-mono text-xs text-on-surface-variant">{duration(run.durationMs, run.createdAt, true)}</span>
                  </div>
                  <p className="truncate text-sm">{run.title ?? 'Untitled session'}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void stop(run.id)} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-error/50 px-3 text-xs text-error"><Square size={12} />Stop</button>
                  <Link href={`/chat?session=${encodeURIComponent(run.sessionId)}`} className="inline-flex min-h-9 items-center rounded-lg border border-primary/40 bg-primary-container/40 px-3 text-xs font-semibold text-primary">Open session</Link>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                <SourceChip source={sourceOf(run)} />
                {sourceDetail(run, byId) && <span>{sourceDetail(run, byId)}</span>}
                <span className="ml-auto font-mono">{tokens(run.totalTokens)} tokens · {cost(run.costUsd)}</span>
              </div>
            </article>)}
          </section>

          <section aria-labelledby="next-h" className="min-w-0 flex-[1_1_300px] space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 id="next-h" className="text-base font-semibold">Up next</h2>
              <Link href="/agents/triggers" className="text-xs font-semibold text-primary">All triggers →</Link>
            </div>
            {data.upcoming.length === 0
              ? <p className="rounded-lg border border-outline-variant/60 bg-surface-container p-4 text-sm text-on-surface-variant">No schedule or heartbeat is enabled.</p>
              : <ol className="divide-y divide-outline-variant/40 rounded-lg border border-outline-variant/60 bg-surface-container">
                {data.upcoming.map((u) => <li key={u.hookId} className="flex gap-3 px-4 py-3">
                  <span className="w-20 shrink-0 font-mono text-xs">{u.nextRunAt ? time(u.nextRunAt) : u.everyMinutes ? `every ${u.everyMinutes}m` : 'each tick'}</span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SourceChip source={u.kind === 'heartbeat' ? 'heartbeat' : 'schedule'} />
                      <span className="text-sm font-medium">{u.name}</span>
                    </div>
                    {u.role && <p className="text-xs text-on-surface-variant">Wakes the {u.role} role when it has ready to-dos</p>}
                    {u.lastError && <p className="text-xs text-error">Last run failed: {u.lastError}</p>}
                  </div>
                </li>)}
              </ol>}
          </section>
        </div>

        <section aria-labelledby="runs-h" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="runs-h" className="text-base font-semibold">All runs today</h2>
            <div role="group" aria-label="Filter by who started the run" className="flex flex-wrap gap-1.5">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="All" count={data.counts.today} />
              {sources.map((s) => <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)} label={sourceLabel(s)} count={data.counts.bySource[s] ?? 0} dot={SOURCE_COLOR[s].dot} />)}
            </div>
          </div>
          {shown.length === 0
            ? <p className="text-sm text-on-surface-variant">{runs.length ? 'No run of this kind today.' : 'No agent has run today.'}</p>
            : <div className="overflow-x-auto rounded-lg border border-outline-variant/60 bg-surface-container">
              <table className="w-full min-w-[880px] border-collapse text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wider text-on-surface-variant">
                  <th className="px-4 py-2.5 font-semibold">Status</th><th className="px-4 py-2.5 font-semibold">Agent</th>
                  <th className="px-4 py-2.5 font-semibold">Started by</th><th className="px-4 py-2.5 font-semibold">Session</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Started</th><th className="px-4 py-2.5 text-right font-semibold">Time</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Tokens</th><th className="px-4 py-2.5 text-right font-semibold">Cost</th>
                  <th className="px-4 py-2.5 font-semibold">Outcome</th>
                </tr></thead>
                <tbody>
                  {shown.map((run) => <tr key={run.id} className="border-t border-outline-variant/40">
                    <td className="px-4 py-2.5"><StatusBadge variant={STATUS_VARIANT[run.status] ?? 'neutral'} dot pulse={run.status === 'running'}>{run.status}</StatusBadge></td>
                    <td className="px-4 py-2.5 font-medium"><Link href={`/agents/view?id=${encodeURIComponent(run.id)}`} className="hover:text-primary">{run.root ? 'Octipus' : run.role}</Link></td>
                    <td className="px-4 py-2.5"><span className="inline-flex flex-wrap items-center gap-2"><SourceChip source={sourceOf(run)} />{sourceDetail(run, byId) && <span className="text-xs text-on-surface-variant">{sourceDetail(run, byId)}</span>}</span></td>
                    <td className="max-w-[16rem] px-4 py-2.5"><Link href={`/chat?session=${encodeURIComponent(run.sessionId)}`} className="block truncate hover:text-primary">{run.title ?? 'Untitled session'}</Link></td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs">{time(run.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs">{duration(run.durationMs, run.createdAt, run.status === 'running')}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{tokens(run.totalTokens)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs">{cost(run.costUsd)}</td>
                    <td className="px-4 py-2.5 text-xs text-on-surface-variant">{outcome(run)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>}
        </section>
      </>}
    </div>
  );
}

function outcome(run: MissionRun): string {
  if (run.status === 'running') return 'in progress';
  if (run.error) return run.error.length > 80 ? `${run.error.slice(0, 80)}…` : run.error;
  if (run.completionReason === 'iteration_limit') return 'stopped at its step limit';
  if (run.completionReason === 'time_limit') return 'stopped at its time limit';
  return run.status;
}

function summarizeSources(runs: MissionRun[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(sourceLabel(sourceOf(r)).toLowerCase(), (counts.get(sourceLabel(sourceOf(r)).toLowerCase()) ?? 0) + 1);
  return [...counts].map(([label, n]) => `${n} ${label}`).join(' · ');
}

function Tile({ label, value, detail, live, tone }: { label: string; value: string; detail: string; live?: boolean; tone?: 'accent' }) {
  return <div className={cn('space-y-1 rounded-lg border p-4', tone === 'accent' ? 'border-accent/50 bg-accent-container' : 'border-outline-variant/60 bg-surface-container')}>
    <p className={cn('text-[11px] font-semibold uppercase tracking-wider', tone === 'accent' ? 'text-accent' : 'text-on-surface-variant')}>{label}</p>
    <p className="flex items-center gap-2 text-2xl font-bold">{live && <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-tertiary" />}{value}</p>
    <p className="text-xs text-on-surface-variant">{detail}</p>
  </div>;
}

function SourceChip({ source }: { source: AgentSource | 'unknown' }) {
  return <span className={cn('inline-flex h-6 items-center whitespace-nowrap rounded-xs border px-2 text-[11px] font-semibold', SOURCE_COLOR[source].chip)}>{sourceLabel(source)}</span>;
}

function FilterChip({ active, onClick, label, count, dot }: { active: boolean; onClick: () => void; label: string; count: number; dot?: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick}
    className={cn('inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs', active ? 'border-primary bg-primary-container/60 text-on-surface' : 'border-outline-variant text-on-surface-variant hover:text-on-surface')}>
    {dot && <span aria-hidden className={cn('h-2 w-2 rounded-full', dot)} />}{label}<span className="font-mono opacity-80">{count}</span>
  </button>;
}
