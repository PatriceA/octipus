'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceId } from '@/lib/workspace-context';
import { AGENT_SOURCE_LABEL, type RosterResponse, type RosterRole } from '../../../../src/shared/agent-origin';
import { HEARTBEAT_SKIP_LABEL, type HeartbeatSkipReasonName } from '../../../../src/shared/triggers';

function isRoster(value: unknown): value is RosterResponse {
  const v = value as Partial<RosterResponse> | null;
  return !!v && Array.isArray(v.roles);
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function displayName(r: RosterRole): string {
  return r.root ? 'Octipus' : r.role;
}

/** What the card says the agent is doing right now. */
function state(r: RosterRole, serverEnabled: boolean): { text: string; tone: string } {
  if (r.liveRuns) return { text: `working · ${r.liveRuns} run${r.liveRuns === 1 ? '' : 's'}`, tone: 'text-tertiary' };
  if (r.heartbeat.enabled && !serverEnabled) return { text: 'heartbeat on · server paused', tone: 'text-warning' };
  if (r.heartbeat.enabled && r.heartbeat.lastCheck?.reason === 'quiet_hours') return { text: 'idle · last check: quiet hours', tone: 'text-on-surface' };
  if (r.heartbeat.enabled) return { text: r.heartbeat.nextCheckAt ? `idle · next check ${hhmm(r.heartbeat.nextCheckAt)}` : 'idle · heartbeat on', tone: 'text-on-surface' };
  if (r.root) return { text: 'answers you in chat', tone: 'text-on-surface' };
  return { text: 'starts when delegated to', tone: 'text-on-surface-variant' };
}

function lastCheckText(c: NonNullable<RosterRole['heartbeat']['lastCheck']>): string {
  if (c.ran) return `${hhmm(c.at)} · started a turn`;
  const label = c.reason && c.reason in HEARTBEAT_SKIP_LABEL ? HEARTBEAT_SKIP_LABEL[c.reason as HeartbeatSkipReasonName] : (c.reason ?? 'skipped');
  return `${hhmm(c.at)} · skipped: ${label.toLowerCase()}`;
}

export default function RosterPage() {
  const workspaceId = useWorkspaceId();
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isError, isFetching, errorUpdatedAt, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['agent-roster', workspaceId],
    queryFn: async () => {
      const response = await api.get<unknown>('/agents/roster');
      if (!isRoster(response)) throw new Error('The server returned data this version of the app cannot read.');
      return response;
    },
    refetchInterval: 15_000,
  });
  const unavailable = isError || errorUpdatedAt > dataUpdatedAt;
  const roles = data?.roles ?? [];
  const current = roles.find((r) => r.role === selected) ?? roles[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roster"
        description="The agents that can work for you. Each is a role with a lane, tools and the ways it starts: delegated to from chat, or woken by its heartbeat to work the to-dos assigned to it."
        actions={<Link href="/topics" className="rounded-lg border border-outline-variant px-3 py-2 text-sm hover:bg-surface-container">Edit roles and lanes</Link>}
      />
      {unavailable && <div role="status" className="flex items-center gap-2 text-sm text-warning">
        {data ? 'Update failed; showing the last loaded state.' : 'The roster could not be loaded.'}
        <button type="button" disabled={isFetching} onClick={() => void refetch()} className="inline-flex items-center gap-1 underline disabled:opacity-60"><RefreshCw size={14} />Retry</button>
      </div>}
      {!data && !unavailable && <p className="text-sm text-on-surface-variant">Loading…</p>}
      {data && (!data.heartbeatEnabled || !data.boardWritesAllowed) && <div role="note" className="space-y-1 rounded-lg border border-warning/50 bg-warning-container/40 p-3 text-sm">
        {!data.heartbeatEnabled && <p>The heartbeat is switched off on this server: no role agent wakes on its own until an admin turns it on. <Link href="/settings?tab=heartbeat" className="text-primary underline">Open heartbeat settings</Link>.</p>}
        {!data.boardWritesAllowed && <p>Role agents cannot update to-dos until you allow <code className="font-mono text-xs">tasks/write</code> in <Link href="/permissions" className="text-primary underline">permissions</Link>; their heartbeat skips until then.</p>}
      </div>}

      {data && roles.length > 0 && current && <div className="flex flex-wrap items-start gap-6">
        <ul className="grid min-w-0 flex-[3_1_520px] gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {roles.map((r) => {
            const s = state(r, data.heartbeatEnabled);
            const on = r.role === current.role;
            return <li key={r.role}><button type="button" aria-pressed={on} onClick={() => setSelected(r.role)}
              className={cn('flex h-full w-full flex-col gap-2.5 rounded-lg border p-4 text-left', on ? 'border-primary bg-primary-container/50' : 'border-outline-variant/60 bg-surface-container hover:border-outline')}>
              <span className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-container text-sm font-bold text-primary">{r.root ? 'O' : r.role.slice(0, 2)}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{displayName(r)}</span>
                  <span className={cn('block text-xs', s.tone)}>{s.text}</span>
                </span>
              </span>
              {r.description && <span className="line-clamp-2 text-xs text-on-surface-variant">{r.description}</span>}
              <span className="mt-auto flex flex-wrap gap-1.5 text-[11px]">
                {r.heartbeat.enabled && <span className="rounded-xs border border-tertiary/50 px-1.5 text-tertiary">Heartbeat</span>}
                {r.tasks.active > 0 && <span className="rounded-xs border border-outline-variant px-1.5 text-on-surface-variant">{r.tasks.active} to-do{r.tasks.active === 1 ? '' : 's'}</span>}
                {r.runsToday > 0 && <span className="rounded-xs border border-outline-variant px-1.5 text-on-surface-variant">{r.runsToday} run{r.runsToday === 1 ? '' : 's'} today</span>}
                {!r.known && <span className="rounded-xs border border-warning/50 px-1.5 text-warning">not in the registry</span>}
              </span>
            </button></li>;
          })}
        </ul>

        <aside aria-label={`${displayName(current)} profile`} className="min-w-0 flex-[2_1_360px] space-y-5 rounded-lg border border-outline-variant bg-surface-container-low p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-container text-base font-bold text-primary">{current.root ? 'O' : current.role.slice(0, 2)}</span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold">{displayName(current)}</h2>
              <p className="text-xs text-on-surface-variant">{current.root ? 'root agent · ' : ''}lane <span className="font-mono">{current.lane}</span> · {current.toolGroups} tool groups{current.readOnly ? ' · read-only' : ''}</p>
            </div>
          </div>
          {current.description && <p className="text-sm text-on-surface-variant">{current.description}</p>}

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Starts when</h3>
            <ul className="space-y-2 text-sm">
              <li className="rounded-lg border border-outline-variant/60 bg-surface-container p-3">{current.root ? 'You send a message, in the web app, terminal or a linked channel.' : 'Octipus or another agent delegates a task to it (spawn_child), or a pipeline stage runs it.'}</li>
              <li className="space-y-2 rounded-lg border border-outline-variant/60 bg-surface-container p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{current.root ? 'Personal heartbeat: checks in on your behalf' : 'Heartbeat: works its to-dos on its own'}</span>
                  <span className="text-xs">{current.heartbeat.enabled && data.heartbeatEnabled ? 'On' : current.heartbeat.enabled ? 'Paused on server' : 'Off'}</span>
                </div>
                {current.root && <p className="text-xs text-on-surface-variant">Uses the same personal heartbeat as Settings. It checks periodically and only starts an agent when something needs attention.</p>}
                {current.heartbeat.enabled && <p className="text-xs text-on-surface-variant">
                  {current.heartbeat.intervalMinutes ? `Checks every ${current.heartbeat.intervalMinutes} min` : 'Checks at the configured interval'}
                  {current.heartbeat.nextCheckAt && <> · next {hhmm(current.heartbeat.nextCheckAt)}</>}
                </p>}
                {current.heartbeat.lastCheck && <p className="text-xs">Last check {lastCheckText(current.heartbeat.lastCheck)} · <Link href="/agents/triggers" className="text-primary underline">why</Link></p>}
                <Link href="/settings?tab=heartbeat" className="text-xs text-primary underline">Manage heartbeat in Settings</Link>
              </li>
            </ul>
          </section>

          {!current.root && <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Assigned to-dos</h3>
            <p className="text-sm">{current.tasks.active} open of {current.tasks.total}{current.tasks.active > 0 && !current.heartbeat.enabled && <span className="text-warning"> · waiting: its heartbeat is off</span>}</p>
            <Link href="/tasks" className="text-xs font-semibold text-primary">Open the to-do board →</Link>
          </section>}

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Today</h3>
            {current.lastRun
              ? <p className="text-sm">{current.runsToday} run{current.runsToday === 1 ? '' : 's'}; latest {hhmm(current.lastRun.createdAt)}, {current.lastRun.status}{current.lastRun.source ? `, started by ${AGENT_SOURCE_LABEL[current.lastRun.source].toLowerCase()}` : ''}{current.lastRun.title ? ` — ${current.lastRun.title}` : ''}.{' '}
                <Link href={`/agents/view?id=${encodeURIComponent(current.lastRun.id)}`} className="text-primary underline">Open run</Link></p>
              : <p className="text-sm text-on-surface-variant">No run today.</p>}
          </section>
        </aside>
      </div>}
    </div>
  );
}
