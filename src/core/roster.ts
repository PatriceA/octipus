/**
 * The Roster (docs/MISSION-CONTROL.md, "Roster"): every role as an agent the
 * user manages — what it is for, which lane runs it, whether its heartbeat
 * picks up to-dos, how many are assigned to it, and what it did today.
 *
 * Heartbeat state and to-do counts come from `listRoleAgents` (per user,
 * like the role heartbeat itself); runs and heartbeat decisions through the
 * principal's scoped repositories.
 */
import { scopedRepos } from '@/db/repositories/scoped';
import { contentRepos } from '@/db/repositories/content';
import type { Principal } from '@/security/principal';
import type { MissionRun, RosterResponse, RosterRole } from '@/shared/agent-origin';
import { listRoleAgents } from './tasks/role-agents';
import { startOfToday } from './mission-control';
import { getAgentManager } from './agent-manager';
import { ROOT_ROLE } from './agent/types';

export async function readRoster(principal: Principal, userId: string, now = new Date()): Promise<RosterResponse> {
  const since = startOfToday(now);
  const [{ ROLE_CONFIGS }, view, runs, hooks] = await Promise.all([
    import('./agent/roles'),
    listRoleAgents(userId),
    contentRepos(principal).agents.listOwnSince(since),
    scopedRepos(principal).hooks.listOwn(),
  ]);
  const hookById = new Map(hooks.map((h) => [h.id, h]));
  // The settings card controls the owner's plain heartbeat, not a role-task heartbeat.
  const personal = hooks.filter(h => h.trigger === 'heartbeat' && h.triggerConfig?.role == null)
    .sort((a, b) => Number(b.isEnabled) - Number(a.isEnabled) || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))[0];
  const checkIds = [...new Set([...view.roles.map(r => r.hookId), personal?.id].filter((id): id is string => !!id))];
  const checks = await scopedRepos(principal).hooks.heartbeatChecksSince(checkIds, since);
  const lastCheck = new Map<string, (typeof checks)[number]>();
  for (const c of checks) lastCheck.set(c.hookId, c);

  const names = new Set<string>([...Object.keys(ROLE_CONFIGS), ...view.roles.map((r) => r.role)]);
  const roles: RosterRole[] = [...names].map((role) => {
    const config = ROLE_CONFIGS[role as keyof typeof ROLE_CONFIGS];
    const agent = view.roles.find((r) => r.role === role);
    const hook = role === ROOT_ROLE ? personal : agent?.hookId ? hookById.get(agent.hookId) : agent?.inherited ? personal : undefined;
    const enabled = role === ROOT_ROLE ? personal?.isEnabled ?? false : agent?.enabled ?? false;
    const check = hook ? lastCheck.get(hook.id) : undefined;
    const interval = (hook?.triggerConfig as { intervalMinutes?: unknown } | undefined)?.intervalMinutes;
    const own = runs.filter((r) => r.role === role);
    const latest = own[0];
    const isLive = (id: string, stored: string) => (getAgentManager().get(id)?.getContext().status ?? stored) === 'running';
    return {
      role,
      root: role === ROOT_ROLE,
      description: config?.description ?? null,
      lane: config?.defaultTopic ?? role,
      toolGroups: config?.toolIds.length ?? 0,
      readOnly: config?.readOnly === true,
      known: !!config,
      heartbeat: {
        enabled,
        hookId: hook?.id ?? null,
        nextCheckAt: enabled && hook?.nextRunAt ? hook.nextRunAt.toISOString() : null,
        intervalMinutes: typeof interval === 'number' ? interval : null,
        lastCheck: check ? { at: check.checkedAt.toISOString(), ran: check.ran, reason: check.reason } : null,
      },
      tasks: { active: agent?.activeTasks ?? 0, total: agent?.totalTasks ?? 0 },
      runsToday: own.length,
      liveRuns: own.filter((r) => isLive(r.id, r.status)).length,
      lastRun: latest ? {
        id: latest.id,
        status: (getAgentManager().get(latest.id)?.getContext().status ?? latest.status) as MissionRun['status'],
        createdAt: latest.createdAt.toISOString(),
        title: latest.sessionTitle,
        source: latest.origin?.source ?? null,
      } : null,
    };
  });

  // The root first, then roles doing something (live, runs, to-dos, a heartbeat), then the rest by name.
  const weight = (r: RosterRole) => (r.root ? 4 : 0) + (r.liveRuns ? 2 : 0) + (r.runsToday || r.tasks.active || r.heartbeat.enabled ? 1 : 0);
  roles.sort((a, b) => weight(b) - weight(a) || a.role.localeCompare(b.role));
  return { roles, boardWritesAllowed: view.boardWritesAllowed, heartbeatEnabled: view.heartbeatEnabled };
}
