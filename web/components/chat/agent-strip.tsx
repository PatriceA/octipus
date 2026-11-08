'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { TrackedAgent } from './agent-activity-card';

const SHOWN = 6;

const STATUS: Record<TrackedAgent['status'], { dot: string; label: string }> = {
  running: { dot: 'bg-tertiary animate-pulse', label: 'working' },
  completed: { dot: 'bg-primary', label: 'done' },
  failed: { dot: 'bg-error', label: 'failed' },
  stopped: { dot: 'bg-outline', label: 'stopped' },
};

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/**
 * The agents this session's turns spawned, at the top of the chat
 * (docs/MISSION-CONTROL.md, "In the chat"): each with its role, state and
 * size, opening its run view. Working ones first; hidden when none spawned.
 */
export function AgentStrip({ agents }: { agents: Map<string, TrackedAgent> }) {
  const spawned = [...agents.values()]
    .filter((a) => !a.root)
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startTime - a.startTime);
  if (spawned.length === 0) return null;
  const working = spawned.filter((a) => a.status === 'running').length;
  return <section aria-label="Spawned agents" className="flex items-center gap-2 overflow-x-auto border-b border-outline-variant/40 px-4 py-2 text-xs">
    <span className="shrink-0 text-on-surface-variant">{working ? `${working} working` : `${spawned.length} spawned`}</span>
    <ul className="flex min-w-0 items-center gap-1.5">
      {spawned.slice(0, SHOWN).map((a) => {
        const s = STATUS[a.status];
        return <li key={a.id} className="shrink-0">
          <Link href={`/agents/view?id=${encodeURIComponent(a.id)}`} title={`${a.role}${a.stageName ? ` · ${a.stageName}` : ''}: ${s.label}`}
            className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 hover:bg-surface-container', a.status === 'running' ? 'border-tertiary/50' : 'border-outline-variant/60')}>
            <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
            <span className="font-medium text-on-surface">{a.stageName ?? a.role}</span>
            <span className="text-on-surface-variant">{s.label}{a.totalTokens ? ` · ${tokens(a.totalTokens)}` : ''}</span>
          </Link>
        </li>;
      })}
    </ul>
    {spawned.length > SHOWN && <Link href="/agents" className="shrink-0 text-primary underline">+{spawned.length - SHOWN} more</Link>}
  </section>;
}
