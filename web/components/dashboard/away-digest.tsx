'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Clock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface AgentBrief { id: string; role: string; status: string; error?: string | null; durationMs?: number | null }
interface PipelineBrief { id: string; title: string; status: string; summary?: string | null; waitingOnYou: boolean }
interface ApprovalBrief { id: string; sessionId: string; summary: string; question: string }
interface TaskBrief { id: string; title: string; source: string }
interface JobBrief { id: string; kind: string; title: string; status: 'done' | 'error' | 'interrupted'; error?: string | null; resultRef?: string | null }
interface AwayDigest {
  since: string;
  until: string;
  agents: { completed: AgentBrief[]; failed: AgentBrief[] };
  pipelines: PipelineBrief[];
  approvals: ApprovalBrief[];
  jobs: JobBrief[];
  tasks: TaskBrief[];
  unreadNotifications: number;
  empty: boolean;
}

/** When the user last pressed "caught up" — the start of the next "away". */
const SEEN_KEY = 'octipus.away.seenAt';
const CAP = 5;

function readSeenAt(): string | null {
  try {
    const v = localStorage.getItem(SEEN_KEY);
    return v && !Number.isNaN(new Date(v).getTime()) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Only render what is actually a digest. An unstubbed proxy, a half-migrated
 * backend or an auth redirect can answer 200 with some other JSON, and a
 * dashboard that crashes on its first card is worse than one missing a card.
 */
function isAwayDigest(x: unknown): x is AwayDigest {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  const agents = d.agents as Record<string, unknown> | undefined;
  return (
    typeof d.since === 'string' &&
    typeof d.empty === 'boolean' &&
    typeof d.unreadNotifications === 'number' &&
    Array.isArray(d.pipelines) && Array.isArray(d.approvals) && Array.isArray(d.jobs) && Array.isArray(d.tasks) &&
    !!agents && Array.isArray(agents.completed) && Array.isArray(agents.failed)
  );
}

function sinceLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `since ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : `since ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/** Where a finished job's output lives: a research report is saved as a document, a processed document is one — both on the documents page. */
function jobHref(j: JobBrief): string {
  return j.kind === 'research' && !j.resultRef ? '/research' : '/documents';
}

function Section({ title, tone, children }: { title: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2">
      <p className={`text-[10px] uppercase tracking-wider ${tone ?? 'text-on-surface-variant'}`}>{title}</p>
      <ul className="mt-1 space-y-0.5 text-[13px] text-on-surface">{children}</ul>
    </div>
  );
}

function More({ n }: { n: number }) {
  return n > CAP ? <li className="text-[11px] text-on-surface-variant">…and {n - CAP} more</li> : null;
}

/**
 * "While you were away" — what finished, failed or is waiting on the user
 * since they last looked. The server folds agents, pipelines, approvals,
 * sourced to-dos and the unread count (`GET /api/digest/away`); this card
 * remembers when the user last caught up and asks from there.
 */
export function AwayDigestCard() {
  const [seenAt, setSeenAt] = useState<string | null>(() => (typeof window === 'undefined' ? null : readSeenAt()));

  // A failed poll THROWS so react-query keeps the last good digest on screen
  // and only flags `error`; returning null would unmount the card for a
  // minute on every blip. No retries: the 60s poll is the retry.
  const { data } = useQuery({
    queryKey: ['digest', 'away', seenAt],
    queryFn: async () => {
      const q = seenAt ? `?since=${encodeURIComponent(seenAt)}` : '';
      const res = await api.get<unknown>(`/digest/away${q}`);
      if (!isAwayDigest(res)) throw new Error('unexpected digest response');
      return res;
    },
    retry: false,
    refetchInterval: 60_000,
  });

  if (!data) return null;

  // Changing the key mounts a fresh query for the new window; nothing to invalidate.
  const caughtUp = () => {
    const now = new Date().toISOString();
    try { localStorage.setItem(SEEN_KEY, now); } catch { /* private mode: the card just uses the default window next time */ }
    setSeenAt(now);
  };

  const waiting = data.pipelines.filter((p) => p.waitingOnYou);
  const finished = data.pipelines.filter((p) => !p.waitingOnYou);
  const jobsFailed = data.jobs.filter((j) => j.status !== 'done');
  const jobsDone = data.jobs.filter((j) => j.status === 'done');
  const needsYou = data.approvals.length + waiting.length + data.agents.failed.length + jobsFailed.length > 0;

  return (
    <div data-testid="away-digest">
    <Card glow={needsYou ? 'warn' : undefined}>
      <CardHeader>
        <CardTitle>while you were away</CardTitle>
        <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
          <Clock className="w-3 h-3" aria-hidden /> {sinceLabel(data.since)}
        </span>
        {!data.empty && (
          <button
            onClick={caughtUp}
            className="ml-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            title="Start the next 'away' from now"
          >
            <CheckCheck className="w-3 h-3" aria-hidden /> caught up
          </button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {data.empty ? (
          <div className="flex flex-col items-center justify-center py-6 text-on-surface-variant">
            <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
            <p className="text-[12px]">nothing happened — no runs finished, nothing is waiting on you</p>
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/40">
            {data.approvals.length > 0 && (
              <Section title={`waiting on you — ${data.approvals.length} approval${data.approvals.length === 1 ? '' : 's'}`} tone="text-warning">
                {data.approvals.slice(0, CAP).map((a) => (
                  <li key={a.id}><Link href="/chat" className="hover:underline">{a.summary}</Link> <span className="text-on-surface-variant">— {a.question}</span></li>
                ))}
                <More n={data.approvals.length} />
              </Section>
            )}
            {waiting.length > 0 && (
              <Section title={`pipelines waiting on you — ${waiting.length}`} tone="text-warning">
                {waiting.slice(0, CAP).map((p) => (
                  <li key={p.id}><Link href="/pipelines" className="hover:underline">{p.title}</Link> <span className="text-on-surface-variant">({p.status.replace('_', ' ')})</span></li>
                ))}
                <More n={waiting.length} />
              </Section>
            )}
            {data.agents.failed.length > 0 && (
              <Section title={`failed — ${data.agents.failed.length} agent${data.agents.failed.length === 1 ? '' : 's'}`} tone="text-error">
                {data.agents.failed.slice(0, CAP).map((a) => (
                  <li key={a.id} className="truncate">
                    <Link href={`/agents/view?id=${encodeURIComponent(a.id)}`} className="hover:underline">{a.role}</Link>
                    {a.status === 'stopped' && <span className="text-on-surface-variant"> (stopped)</span>}
                    {a.error && <span className="text-on-surface-variant">: {a.error}</span>}
                  </li>
                ))}
                <More n={data.agents.failed.length} />
              </Section>
            )}
            {jobsFailed.length > 0 && (
              <Section title={`background work failed — ${jobsFailed.length}`} tone="text-error">
                {jobsFailed.slice(0, CAP).map((j) => (
                  <li key={j.id} className="truncate">
                    <Link href={jobHref(j)} className="hover:underline">{j.title}</Link>
                    <span className="text-on-surface-variant"> ({j.kind}){j.status === 'interrupted' ? ' — interrupted by a restart' : j.error ? `: ${j.error}` : ''}</span>
                  </li>
                ))}
                <More n={jobsFailed.length} />
              </Section>
            )}
            {finished.length > 0 && (
              <Section title={`pipelines — ${finished.length}`}>
                {finished.slice(0, CAP).map((p) => (
                  <li key={p.id} className="truncate"><Link href="/pipelines" className="hover:underline">{p.title}</Link> <span className="text-on-surface-variant">{p.status}{p.summary ? ` — ${p.summary}` : ''}</span></li>
                ))}
                <More n={finished.length} />
              </Section>
            )}
            {data.agents.completed.length > 0 && (
              <Section title={`finished — ${data.agents.completed.length} agent${data.agents.completed.length === 1 ? '' : 's'}`}>
                {data.agents.completed.slice(0, CAP).map((a) => (
                  <li key={a.id}><Link href={`/agents/view?id=${encodeURIComponent(a.id)}`} className="hover:underline">{a.role}</Link></li>
                ))}
                <More n={data.agents.completed.length} />
              </Section>
            )}
            {jobsDone.length > 0 && (
              <Section title={`background work — ${jobsDone.length}`}>
                {jobsDone.slice(0, CAP).map((j) => (
                  <li key={j.id} className="truncate"><Link href={jobHref(j)} className="hover:underline">{j.title}</Link> <span className="text-on-surface-variant">({j.kind})</span></li>
                ))}
                <More n={jobsDone.length} />
              </Section>
            )}
            {data.tasks.length > 0 && (
              <Section title={`new to-dos for you — ${data.tasks.length}`}>
                {data.tasks.slice(0, CAP).map((t) => (
                  <li key={t.id} className="truncate"><Link href="/tasks" className="hover:underline">{t.title}</Link> <span className="text-on-surface-variant">from {t.source}</span></li>
                ))}
                <More n={data.tasks.length} />
              </Section>
            )}
            {data.unreadNotifications > 0 && (
              <div className="px-3 py-2 text-[12px] text-on-surface-variant">
                <Link href="/notifications" className="text-primary hover:underline">{data.unreadNotifications} new unread</Link> in the inbox
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
