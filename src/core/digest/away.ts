/**
 * "While you were away" — one list of what happened to a user's work since
 * a point in time: agents that finished or failed, pipelines that completed
 * or now wait on them, approvals blocking a run, background work (research
 * runs, document processing) that finished or died, to-dos that other things
 * created for them, and how much of the inbox is unread.
 *
 * The state tables (`agents`, `pipelines`, `background_jobs`, `tasks`, `notifications`) already
 * hold the answer per user; this folds them into one shape and one rendering
 * so the dashboard card, the API and the Daily Briefing agree on what "away"
 * contained. Pending approvals are in-process (`ApprovalManager`), so they
 * are read through an injectable dependency rather than a table.
 */
import { scopedRepos } from '@/db/repositories/scoped';
import type { Principal } from '@/security/principal';

export interface AgentBrief { id: string; role: string; status: 'completed' | 'failed' | 'stopped'; finishedAt: string; error?: string | null; durationMs?: number | null }
export interface PipelineBrief { id: string; title: string; status: string; summary?: string | null; changedAt: string; waitingOnYou: boolean }
export interface ApprovalBrief { id: string; sessionId: string; summary: string; question: string }
export interface TaskBrief { id: string; title: string; source: string; createdAt: string }
/** A research run or a document that finished, failed, or was cut off by a restart. */
export interface JobBrief { id: string; kind: string; title: string; status: 'done' | 'error' | 'interrupted'; error?: string | null; resultRef?: string | null; finishedAt: string }

export interface AwayDigest {
  since: string;
  until: string;
  agents: { completed: AgentBrief[]; failed: AgentBrief[] };
  pipelines: PipelineBrief[];
  approvals: ApprovalBrief[];
  jobs: JobBrief[];
  tasks: TaskBrief[];
  /** Unread notifications CREATED in the window — not the whole inbox backlog. */
  unreadNotifications: number;
  /** Nothing in any section. */
  empty: boolean;
}

export interface AwayDigestDeps {
  /** In-process approvals waiting on this user. Injectable: the manager lives on the agent service. */
  pendingApprovals: (userId: string) => Promise<ApprovalBrief[]>;
  now?: () => Date;
}

const DEFAULT_HOURS = 24;
/** Never look back further than this — a month-old "away" is a history page, not a digest. */
export const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SECTION_CAP = 50;

export function defaultSince(now: Date = new Date(), hours = DEFAULT_HOURS): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

/** Clamp a requested `since` into [now - 30d, now]. */
export function clampSince(since: Date, now: Date = new Date()): Date {
  const floor = now.getTime() - MAX_LOOKBACK_MS;
  return new Date(Math.min(now.getTime(), Math.max(floor, since.getTime())));
}

async function defaultPendingApprovals(userId: string): Promise<ApprovalBrief[]> {
  // Lazy: `core/agent` is the heavy end of the import graph and the digest
  // is also read from the hook path, which must not pull it in at load time.
  const { getAgentService } = await import('@/core/agent/service');
  return getAgentService()
    .getPendingApprovals(userId)
    .map((a) => ({ id: a.id, sessionId: a.sessionId, summary: a.summary, question: a.question }));
}

const WAITING_STATUSES = new Set(['paused', 'awaiting_approval']);

export async function collectAwayDigest(
  principal: Principal,
  since: Date,
  deps: Partial<AwayDigestDeps> = {},
): Promise<AwayDigest> {
  const now = (deps.now ?? (() => new Date()))();
  const from = clampSince(since, now);
  const repos = scopedRepos(principal);
  const [agents, pipelines, jobs, tasks, unreadNotifications, approvals] = await Promise.all([
    repos.agents.finishedSince(from, SECTION_CAP),
    repos.pipelines.changedSince(from, SECTION_CAP),
    repos.jobs.finishedSince(from, SECTION_CAP),
    repos.tasks.createdSince(from, { excludeSource: 'user', limit: SECTION_CAP }),
    // Windowed: an unread notification from last week is the inbox's business,
    // not this window's — otherwise "nothing happened" is never reachable.
    repos.notifications.unreadCount(from),
    (deps.pendingApprovals ?? defaultPendingApprovals)(principal.userId),
  ]);

  const briefs: AgentBrief[] = agents.map((a) => ({
    id: a.id,
    role: a.role,
    status: a.status as AgentBrief['status'],
    finishedAt: (a.completedAt ?? a.createdAt).toISOString(),
    error: a.error,
    durationMs: a.durationMs,
  }));

  const completed = briefs.filter((b) => b.status === 'completed');
  const failed = briefs.filter((b) => b.status !== 'completed');
  const pipelineBriefs: PipelineBrief[] = pipelines.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    summary: p.summary,
    changedAt: p.updatedAt.toISOString(),
    waitingOnYou: WAITING_STATUSES.has(p.status),
  }));
  const jobBriefs: JobBrief[] = jobs.map((j) => ({
    id: j.id,
    kind: j.kind,
    title: j.title,
    status: j.status as JobBrief['status'],
    error: j.error,
    resultRef: j.resultRef,
    finishedAt: (j.finishedAt ?? j.updatedAt).toISOString(),
  }));
  const taskBriefs: TaskBrief[] = tasks.map((t) => ({ id: t.id, title: t.title, source: t.source, createdAt: t.createdAt.toISOString() }));
  return {
    since: from.toISOString(),
    until: now.toISOString(),
    agents: { completed, failed },
    pipelines: pipelineBriefs,
    approvals,
    jobs: jobBriefs,
    tasks: taskBriefs,
    unreadNotifications,
    empty:
      completed.length + failed.length + pipelineBriefs.length + approvals.length + jobBriefs.length + taskBriefs.length + unreadNotifications === 0,
  };
}

function countBy<T>(items: readonly T[], key: (t: T) => string): string {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(key(it), (counts.get(key(it)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(', ');
}

function humanDuration(ms: number | null | undefined): string {
  if (!ms || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return ` in ${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? ` in ${m}m${s % 60 ? ` ${s % 60}s` : ''}` : ` in ${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The digest as markdown. Deterministic, so the same facts always read the
 * same way whether the dashboard shows them or the briefing agent is handed
 * them. Approvals first: they are the only section where nothing moves until
 * the user does something.
 */
export function renderAwayDigest(d: AwayDigest, opts: { maxPerSection?: number } = {}): string {
  const cap = opts.maxPerSection ?? 5;
  const lines: string[] = [];
  const sinceLabel = d.since.replace('T', ' ').slice(0, 16);
  lines.push(`## While you were away (since ${sinceLabel} UTC)`);
  if (d.empty) {
    lines.push('', 'Nothing happened: no runs finished, nothing is waiting on you.');
    return lines.join('\n');
  }
  const more = (n: number) => (n > cap ? `- …and ${n - cap} more` : null);

  if (d.approvals.length) {
    lines.push('', `**Waiting on you — ${d.approvals.length} approval${d.approvals.length === 1 ? '' : 's'}**`);
    for (const a of d.approvals.slice(0, cap)) lines.push(`- ${a.summary}: ${a.question}`);
    const m = more(d.approvals.length); if (m) lines.push(m);
  }
  const waiting = d.pipelines.filter((p) => p.waitingOnYou);
  const finished = d.pipelines.filter((p) => !p.waitingOnYou);
  if (waiting.length) {
    lines.push('', `**Pipelines waiting on you — ${waiting.length}**`);
    for (const p of waiting.slice(0, cap)) lines.push(`- ${p.title} (${p.status.replace('_', ' ')})`);
    const m = more(waiting.length); if (m) lines.push(m);
  }
  if (d.agents.failed.length) {
    lines.push('', `**Failed — ${d.agents.failed.length} agent${d.agents.failed.length === 1 ? '' : 's'}** (${countBy(d.agents.failed, (a) => a.role)})`);
    for (const a of d.agents.failed.slice(0, cap)) lines.push(`- ${a.role}${a.status === 'stopped' ? ' (stopped)' : ''}${a.error ? `: ${a.error.slice(0, 160)}` : ''}`);
    const m = more(d.agents.failed.length); if (m) lines.push(m);
  }
  const jobsFailed = d.jobs.filter((j) => j.status !== 'done');
  const jobsDone = d.jobs.filter((j) => j.status === 'done');
  if (jobsFailed.length) {
    lines.push('', `**Background work failed — ${jobsFailed.length}** (${countBy(jobsFailed, (j) => j.kind)})`);
    for (const j of jobsFailed.slice(0, cap)) lines.push(`- ${j.kind}: ${j.title.slice(0, 80)}${j.status === 'interrupted' ? ' (interrupted by a restart)' : j.error ? `: ${j.error.slice(0, 160)}` : ''}`);
    const m = more(jobsFailed.length); if (m) lines.push(m);
  }
  if (finished.length) {
    lines.push('', `**Pipelines — ${finished.length}**`);
    for (const p of finished.slice(0, cap)) lines.push(`- ${p.title}: ${p.status}${p.summary ? ` — ${p.summary.slice(0, 160)}` : ''}`);
    const m = more(finished.length); if (m) lines.push(m);
  }
  if (d.agents.completed.length) {
    lines.push('', `**Finished — ${d.agents.completed.length} agent${d.agents.completed.length === 1 ? '' : 's'}** (${countBy(d.agents.completed, (a) => a.role)})`);
    for (const a of d.agents.completed.slice(0, cap)) lines.push(`- ${a.role}${humanDuration(a.durationMs)}`);
    const m = more(d.agents.completed.length); if (m) lines.push(m);
  }
  if (jobsDone.length) {
    lines.push('', `**Background work — ${jobsDone.length}** (${countBy(jobsDone, (j) => j.kind)})`);
    for (const j of jobsDone.slice(0, cap)) lines.push(`- ${j.kind}: ${j.title.slice(0, 80)}`);
    const m = more(jobsDone.length); if (m) lines.push(m);
  }
  if (d.tasks.length) {
    lines.push('', `**New to-dos for you — ${d.tasks.length}** (${countBy(d.tasks, (t) => `from ${t.source}`)})`);
    for (const t of d.tasks.slice(0, cap)) lines.push(`- ${t.title}`);
    const m = more(d.tasks.length); if (m) lines.push(m);
  }
  if (d.unreadNotifications) {
    lines.push('', `${d.unreadNotifications} new unread notification${d.unreadNotifications === 1 ? '' : 's'} in the inbox.`);
  }
  return lines.join('\n');
}
