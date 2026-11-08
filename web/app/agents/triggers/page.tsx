'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceId } from '@/lib/workspace-context';
import {
  HEARTBEAT_SKIP_LABEL,
  HEARTBEAT_SKIP_REASONS,
  type HeartbeatSkipReasonName,
  type TriggerEvent,
  type TriggerSummary,
  type TriggersResponse,
} from '../../../../src/shared/triggers';

const KIND_LABEL: Record<string, string> = {
  heartbeat: 'Heartbeat', schedule: 'Schedule', webhook: 'Webhook', message_received: 'On message',
  agent_started: 'On agent start', agent_completed: 'On agent finish', agent_failed: 'On agent failure',
  tool_executed: 'On tool use', permission_requested: 'On approval request',
};
const KIND_CHIP: Record<string, string> = {
  heartbeat: 'border-tertiary/50 text-tertiary', schedule: 'border-warning/50 text-warning', webhook: 'border-accent/50 text-accent',
};

function isTriggers(value: unknown): value is TriggersResponse {
  const v = value as Partial<TriggersResponse> | null;
  return !!v && Array.isArray(v.triggers) && !!v.funnel && typeof v.since === 'string';
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function reasonText(e: TriggerEvent): string {
  if (e.kind === 'ran') return e.readyTasks ? `Started a turn for ${e.readyTasks} ready to-do${e.readyTasks === 1 ? '' : 's'}` : 'Started a turn';
  if (e.kind === 'failed') return e.reason ? `Failed: ${e.reason}` : 'Failed';
  const label = e.reason && e.reason in HEARTBEAT_SKIP_LABEL ? HEARTBEAT_SKIP_LABEL[e.reason as HeartbeatSkipReasonName] : (e.reason ?? 'Skipped');
  return e.reason === 'tasks_permission_required' && e.readyTasks ? `${label} (${e.readyTasks} ready)` : label;
}

function cadence(t: TriggerSummary): string {
  if (t.kind === 'heartbeat') return t.intervalMinutes ? `checks every ${t.intervalMinutes} min` : 'checks at the configured interval';
  if (t.kind === 'schedule') return 'on its schedule';
  if (t.kind === 'webhook') return 'when the webhook is called';
  return 'on its event';
}

export default function TriggersPage() {
  const workspaceId = useWorkspaceId();
  const { data, isError, isFetching, errorUpdatedAt, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['agent-triggers', workspaceId],
    queryFn: async () => {
      const response = await api.get<unknown>('/agents/triggers');
      if (!isTriggers(response)) throw new Error('The server returned data this version of the app cannot read.');
      return response;
    },
    refetchInterval: 30_000,
  });
  const unavailable = isError || errorUpdatedAt > dataUpdatedAt;
  const heartbeats = (data?.triggers ?? []).filter((t) => t.kind === 'heartbeat');
  const [explain, setExplain] = useState<string | null>(null);
  const explained = heartbeats.find((t) => t.hookId === explain) ?? heartbeats[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Triggers"
        description="Everything that starts an agent without you typing: heartbeats, schedules, webhooks and event hooks. Each shows what it decided today, and a heartbeat says why it did not run."
        actions={<Link href="/hooks" className="rounded-lg border border-outline-variant px-3 py-2 text-sm hover:bg-surface-container">Edit in Hooks & schedules</Link>}
      />
      {unavailable && <div role="status" className="flex items-center gap-2 text-sm text-warning">
        {data ? 'Update failed; showing the last loaded state.' : 'Triggers could not be loaded.'}
        <button type="button" disabled={isFetching} onClick={() => void refetch()} className="inline-flex items-center gap-1 underline disabled:opacity-60"><RefreshCw size={14} />Retry</button>
      </div>}
      {!data && !unavailable && <p className="text-sm text-on-surface-variant">Loading…</p>}

      {data && data.triggers.length === 0 && <p className="rounded-lg border border-outline-variant/60 bg-surface-container p-4 text-sm text-on-surface-variant">
        No trigger is set up. Turn on the heartbeat in Settings, give a role a heartbeat from the to-do board, or add a schedule in <Link href="/hooks" className="text-primary underline">Hooks & schedules</Link>.
      </p>}

      {data && data.triggers.length > 0 && <>
        <Timeline data={data} />

        <div className="flex flex-wrap items-start gap-6">
          <section aria-labelledby="funnel-h" className="min-w-0 flex-[1_1_380px] space-y-3">
            <h2 id="funnel-h" className="text-base font-semibold">Heartbeat checks today</h2>
            {data.funnel.checks === 0
              ? <p className="rounded-lg border border-outline-variant/60 bg-surface-container p-4 text-sm text-on-surface-variant">{heartbeats.length ? 'No heartbeat has checked yet today.' : 'No heartbeat is set up.'}</p>
              : <Funnel funnel={data.funnel} />}
          </section>

          <section aria-labelledby="why-h" className="min-w-0 flex-[1_1_380px] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="why-h" className="text-base font-semibold">Why did it run, or not?</h2>
              {heartbeats.length > 1 && <label className="flex items-center gap-2 text-xs text-on-surface-variant">Heartbeat
                <select value={explained?.hookId} onChange={(e) => setExplain(e.target.value)} className="h-8 rounded-lg px-2 text-xs">
                  {heartbeats.map((h) => <option key={h.hookId} value={h.hookId}>{h.name}</option>)}
                </select>
              </label>}
            </div>
            {!explained ? <p className="text-sm text-on-surface-variant">No heartbeat is set up.</p>
              : explained.events.length === 0 ? <p className="rounded-lg border border-outline-variant/60 bg-surface-container p-4 text-sm text-on-surface-variant">{explained.name} has not checked yet today.</p>
              : <ol className="divide-y divide-outline-variant/40 rounded-lg border border-outline-variant/60 bg-surface-container">
                {explained.nextRunAt && <li className="flex gap-3 px-4 py-2.5 text-sm"><span className="w-20 shrink-0 whitespace-nowrap font-mono text-xs text-on-surface-variant">{hhmm(explained.nextRunAt)}</span><span className="text-on-surface-variant">Next check</span></li>}
                {explained.events.slice(-8).reverse().map((e) => <li key={e.at + e.kind} className="flex gap-3 px-4 py-2.5 text-sm">
                  <span className="w-20 shrink-0 whitespace-nowrap font-mono text-xs text-on-surface-variant">{hhmm(e.at)}</span>
                  <span className={cn('h-5 shrink-0 whitespace-nowrap rounded-xs border px-1.5 text-[11px] font-semibold', e.kind === 'ran' ? 'border-primary/50 text-primary' : e.kind === 'failed' ? 'border-error/50 text-error' : 'border-outline-variant text-on-surface-variant')}>{e.kind}</span>
                  <span className="min-w-0">{reasonText(e)}</span>
                </li>)}
              </ol>}
          </section>
        </div>

        <section aria-labelledby="all-h" className="space-y-3">
          <h2 id="all-h" className="text-base font-semibold">All triggers</h2>
          <div className="overflow-x-auto rounded-lg border border-outline-variant/60 bg-surface-container">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-on-surface-variant">
                <th className="px-4 py-2.5 font-semibold">Type</th><th className="px-4 py-2.5 font-semibold">Trigger</th>
                <th className="px-4 py-2.5 font-semibold">Starts</th><th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Today</th><th className="px-4 py-2.5 font-semibold">Next</th>
                <th className="px-4 py-2.5 font-semibold">State</th>
              </tr></thead>
              <tbody>{data.triggers.map((t) => {
                const ran = t.events.filter((e) => e.kind === 'ran').length;
                const failed = t.events.filter((e) => e.kind === 'failed').length;
                const skippedCount = t.events.filter((e) => e.kind === 'skipped').length;
                return <tr key={t.hookId} className="border-t border-outline-variant/40">
                  <td className="px-4 py-2.5"><span className={cn('inline-flex h-6 items-center whitespace-nowrap rounded-xs border px-2 text-[11px] font-semibold', KIND_CHIP[t.kind] ?? 'border-outline-variant text-on-surface-variant')}>{KIND_LABEL[t.kind] ?? t.kind}</span></td>
                  <td className="px-4 py-2.5 font-medium">{t.name}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{t.role ? `${t.role} (role agent)` : t.action.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{cadence(t)}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {ran + failed + skippedCount === 0 ? <span className="text-on-surface-variant">nothing yet</span>
                      : <>{ran > 0 && <span className="text-primary">{ran} ran</span>}{failed > 0 && <span className="ml-2 text-error">{failed} failed</span>}{skippedCount > 0 && <span className="ml-2 text-on-surface-variant">{skippedCount} skipped</span>}</>}
                    {t.lastError && failed === 0 && <span className="block text-error">last error: {t.lastError}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{t.enabled && t.nextRunAt ? hhmm(t.nextRunAt) : '—'}</td>
                  <td className="px-4 py-2.5 text-xs">{t.enabled ? <span className="text-tertiary">on</span> : <span className="text-on-surface-variant">off</span>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>
      </>}
    </div>
  );
}

function Funnel({ funnel }: { funnel: TriggersResponse['funnel'] }) {
  const rows = HEARTBEAT_SKIP_REASONS.filter((r) => (funnel.skipped[r] ?? 0) > 0);
  const skippedTotal = rows.reduce((n, r) => n + (funnel.skipped[r] ?? 0), 0);
  const bar = (n: number, color: string) => <span className="h-3.5 flex-1 overflow-hidden rounded-xs bg-background/60"><span className={cn('block h-full', color)} style={{ width: `${Math.max((n / funnel.checks) * 100, n ? 2 : 0)}%` }} /></span>;
  return <div className="space-y-2.5 rounded-lg border border-outline-variant/60 bg-surface-container p-4">
    <p className="text-xs text-on-surface-variant">The gate runs its cheapest checks first; only a check that finds work starts a model call.</p>
    <div className="flex items-center gap-3 text-sm font-semibold"><span className="w-60 shrink-0">Checks</span>{bar(funnel.checks, 'bg-outline-variant')}<span className="w-10 text-right font-mono">{funnel.checks}</span></div>
    {rows.map((r) => <div key={r} className="flex items-center gap-3 text-sm text-on-surface-variant"><span className="w-60 shrink-0">− {HEARTBEAT_SKIP_LABEL[r]}</span>{bar(funnel.skipped[r] ?? 0, r === 'in_flight' || r === 'tasks_permission_required' ? 'bg-warning' : 'bg-outline')}<span className="w-10 text-right font-mono">{funnel.skipped[r]}</span></div>)}
    <div className="flex items-center gap-3 text-sm font-semibold text-primary"><span className="w-60 shrink-0">= Started a turn</span>{bar(funnel.ran, 'bg-primary')}<span className="w-10 text-right font-mono">{funnel.ran}</span></div>
    <p className="border-t border-outline-variant/40 pt-2 text-xs text-on-surface-variant">{skippedTotal} skipped check{skippedTotal === 1 ? '' : 's'} used no model tokens.</p>
  </div>;
}

function Timeline({ data }: { data: TriggersResponse }) {
  const start = new Date(data.since).getTime();
  const pos = (iso: string) => Math.min(Math.max(((new Date(iso).getTime() - start) / 86_400_000) * 100, 0), 100);
  const nowPos = pos(data.now);
  const lanes = data.triggers.filter((t) => t.enabled || t.events.length > 0);
  const marker: Record<TriggerEvent['kind'], string> = {
    ran: 'top-1.5 h-3 w-3 -ml-1.5 rounded-full bg-primary',
    failed: 'top-1.5 h-3 w-3 -ml-1.5 rounded-full bg-error',
    skipped: 'top-[9px] h-1.5 w-1.5 -ml-[3px] rounded-full border border-on-surface-variant bg-surface-container',
  };
  return <section aria-labelledby="day-h" className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="day-h" className="text-base font-semibold">Today</h2>
      <div className="flex flex-wrap gap-4 text-[11px] text-on-surface-variant">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-primary" />started an agent</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-error" />failed</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full border border-on-surface-variant" />checked, skipped</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border border-dashed border-on-surface" />next</span>
      </div>
    </div>
    <div className="overflow-x-auto rounded-lg border border-outline-variant/60 bg-surface-container">
      <div className="min-w-[760px] px-4 py-3">
        <div className="flex gap-3 pb-1">
          <span className="w-48 shrink-0" />
          <div className="relative h-4 flex-1 font-mono text-[10px] text-on-surface-variant">
            {[0, 6, 12, 18].map((h) => <span key={h} className="absolute" style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}
            <span className="absolute right-0">24</span>
          </div>
        </div>
        {lanes.map((t) => <div key={t.hookId} className="flex items-center gap-3 border-t border-outline-variant/40 py-1.5">
          <span className="w-48 shrink-0 min-w-0"><span className="block truncate text-xs font-semibold">{t.name}</span><span className="block text-[11px] text-on-surface-variant">{KIND_LABEL[t.kind] ?? t.kind}</span></span>
          <div className="relative h-6 flex-1" role="img" aria-label={`${t.name}: ${t.events.filter((e) => e.kind === 'ran').length} ran, ${t.events.filter((e) => e.kind === 'skipped').length} skipped, ${t.events.filter((e) => e.kind === 'failed').length} failed today`}>
            <span className="absolute inset-x-0 top-3 h-px bg-outline-variant" />
            <span className="absolute -top-0.5 bottom-[-2px] w-px bg-primary" style={{ left: `${nowPos}%` }} />
            {t.events.map((e) => <span key={e.at + e.kind} title={`${hhmm(e.at)} · ${reasonText(e)}`} className={cn('absolute', marker[e.kind])} style={{ left: `${pos(e.at)}%` }} />)}
            {t.enabled && t.nextRunAt && pos(t.nextRunAt) < 100 && <span title={`next ${hhmm(t.nextRunAt)}`} className="absolute top-1.5 -ml-1.5 h-3 w-3 rounded-full border border-dashed border-on-surface" style={{ left: `${pos(t.nextRunAt)}%` }} />}
          </div>
        </div>)}
      </div>
    </div>
  </section>;
}
