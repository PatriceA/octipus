/**
 * Mission control (docs/MISSION-CONTROL.md): every agent run of the user's
 * day in one list, whoever started it, with what is running now, what waits
 * on them and which hooks run next.
 *
 * Reads go through the principal's scoped repositories, so the list holds
 * the user's own agents in the current workspace only — never another
 * user's, never a space's for a non-member.
 */
import { getAgentManager } from '@/core/agent-manager';
import { contentRepos } from '@/db/repositories/content';
import { scopedRepos } from '@/db/repositories/scoped';
import type { AgentRecord } from '@/db/schema/agents';
import type { Principal } from '@/security/principal';
import { readAgentCompletionReason } from '@/shared/agent-completion';
import type { AgentSource, MissionControlResponse, MissionRun, MissionUpcoming } from '@/shared/agent-origin';
import { coreLogger } from '@/utils/logger';

/** Runs listed; a busy day past this shows its newest. */
export const MISSION_RUNS_LIMIT = 200;
const UPCOMING_LIMIT = 8;

/** Midnight today in the server's timezone. */
export function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

type Row = AgentRecord & { sessionTitle: string | null };

function toRun(row: Row, costUsd: number | null): MissionRun {
  const live = getAgentManager().get(row.id);
  const ctx = live?.getContext();
  const info = live ? getAgentManager().list().find((a) => a.id === row.id) : undefined;
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    model: row.model,
    // The live worker is the truth for a running agent; the row for a finished one.
    status: (ctx?.status ?? row.status) as MissionRun['status'],
    root: row.metadata?.root === true,
    parentAgentId: row.parentAgentId ?? null,
    origin: row.origin ?? null,
    title: row.sessionTitle,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    durationMs: info?.durationMs ?? row.durationMs ?? null,
    totalTokens: info?.totalTokens ?? row.totalTokens ?? 0,
    costUsd,
    error: row.error ?? null,
    completionReason: readAgentCompletionReason(row.metadata) ?? null,
  };
}

export async function readMissionControl(principal: Principal, userId: string, now = new Date()): Promise<MissionControlResponse> {
  const repos = contentRepos(principal);
  const since = startOfToday(now);
  const rows = await repos.agents.listOwnSince(since, MISSION_RUNS_LIMIT);

  // A run still going that started before midnight belongs on today's board.
  const listed = new Set(rows.map((r) => r.id));
  const earlierLive = getAgentManager().list().filter((a) => a.userId === userId && !listed.has(a.id) && a.status === 'running');
  for (const a of earlierLive) {
    const row = await repos.agents.findById(a.id);
    if (row) rows.push({ ...row, sessionTitle: null });
  }

  const [costs, spendTodayUsd, pending, hooks] = await Promise.all([
    repos.agents.costByAgent(rows.map((r) => r.id)),
    repos.agents.spendSince(since),
    import('@/security/permissions').then(({ getPermissionManager }) => getPermissionManager().getPendingRequests(userId)).catch((err) => {
      coreLogger.warn({ err, userId }, 'Mission control: pending approvals could not be read');
      return null;
    }),
    scopedRepos(principal).hooks.listOwn(),
  ]);

  const runs = rows.map((r) => toRun(r, costs.get(r.id) ?? null));
  const bySource: MissionControlResponse['counts']['bySource'] = {};
  for (const run of runs) {
    const key: AgentSource | 'unknown' = run.origin?.source ?? 'unknown';
    bySource[key] = (bySource[key] ?? 0) + 1;
  }

  const upcoming: MissionUpcoming[] = hooks
    .filter((h) => h.isEnabled && (h.trigger === 'schedule' || h.trigger === 'heartbeat'))
    .map((h) => {
      const config = (h.triggerConfig ?? {}) as { role?: unknown; intervalMinutes?: unknown };
      return {
        hookId: h.id,
        name: h.name,
        kind: h.trigger,
        role: typeof config.role === 'string' ? config.role : null,
        nextRunAt: h.nextRunAt ? h.nextRunAt.toISOString() : null,
        everyMinutes: typeof config.intervalMinutes === 'number' ? config.intervalMinutes : null,
        lastError: h.lastError ?? null,
      };
    })
    // Dated runs first, soonest first; heartbeats (checked every tick) after.
    .sort((a, b) => (a.nextRunAt ?? '9999').localeCompare(b.nextRunAt ?? '9999'))
    .slice(0, UPCOMING_LIMIT);

  return {
    since: since.toISOString(),
    runs,
    counts: {
      live: runs.filter((r) => r.status === 'running').length,
      today: runs.length,
      failedToday: runs.filter((r) => r.status === 'failed').length,
      bySource,
    },
    spendTodayUsd,
    pendingApprovals: pending === null ? null : pending.length,
    upcoming,
  };
}
