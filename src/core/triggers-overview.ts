/**
 * The Triggers page's data (docs/MISSION-CONTROL.md, "Triggers"): the user's
 * hooks with today's heartbeat decisions and executions, and the heartbeat
 * funnel. Read through the principal's scoped repositories.
 */
import { scopedRepos } from '@/db/repositories/scoped';
import type { Principal } from '@/security/principal';
import type { HeartbeatSkipReasonName, TriggerEvent, TriggersResponse } from '@/shared/triggers';
import { startOfToday } from './mission-control';

export async function readTriggers(principal: Principal, now = new Date()): Promise<TriggersResponse> {
  const repo = scopedRepos(principal).hooks;
  const since = startOfToday(now);
  const [hooks, monitorRows, goalRows] = await Promise.all([repo.listOwn(), repo.monitorsOwn(), repo.companionGoalsOwn()]);
  const ids = hooks.map((h) => h.id);
  // Goals still being worked, or touched today: a goal done last week is not a trigger.
  const goals = goalRows.filter((g) => !['completed', 'cancelled'].includes(g.state) || g.updatedAt >= since);
  const [checks, executions, actions] = await Promise.all([
    repo.heartbeatChecksSince(ids, since), repo.executionsSince(ids, since), repo.companionActionsSince(goals.map((g) => g.id), since),
  ]);

  const events = new Map<string, TriggerEvent[]>();
  const push = (hookId: string | null, e: TriggerEvent) => {
    if (!hookId) return;
    events.set(hookId, [...(events.get(hookId) ?? []), e]);
  };
  const heartbeatIds = new Set(hooks.filter((h) => h.trigger === 'heartbeat').map((h) => h.id));
  for (const c of checks) {
    push(c.hookId, { at: c.checkedAt.toISOString(), kind: c.ran ? 'ran' : 'skipped', reason: c.reason, readyTasks: c.readyTasks });
  }
  // A heartbeat's run is its check; its execution row adds only a failure.
  for (const x of executions) {
    if (x.hookId && heartbeatIds.has(x.hookId) && x.status !== 'error') continue;
    if (x.status === 'skipped') continue;
    push(x.hookId, { at: x.createdAt.toISOString(), kind: x.status === 'error' ? 'failed' : 'ran', reason: x.error, readyTasks: null });
  }

  // A Companion action that reached a session is a run; a failed one a failure; queued or cancelled ones are not events.
  for (const a of actions) {
    if (a.status === 'completed' || a.status === 'running') push(a.goalId, { at: a.createdAt.toISOString(), kind: 'ran', reason: a.kind.replace(/_/g, ' '), readyTasks: null });
    else if (a.status === 'failed' || a.status === 'unknown') push(a.goalId, { at: a.createdAt.toISOString(), kind: 'failed', reason: `${a.kind.replace(/_/g, ' ')}: ${a.status}`, readyTasks: null });
  }
  // A monitor keeps its last check, not a history: today's shows as one event.
  const monitorsShown = monitorRows.filter((m) => !['completed', 'cancelled'].includes(m.status) || (m.lastCheckedAt && m.lastCheckedAt >= since));
  for (const m of monitorsShown) {
    if (m.lastCheckedAt && m.lastCheckedAt >= since) push(m.id, { at: m.lastCheckedAt.toISOString(), kind: m.lastError ? 'failed' : 'skipped', reason: m.lastError ?? 'checked', readyTasks: null });
  }

  const skipped: Partial<Record<HeartbeatSkipReasonName, number>> = {};
  for (const c of checks) {
    if (!c.ran && c.reason) skipped[c.reason as HeartbeatSkipReasonName] = (skipped[c.reason as HeartbeatSkipReasonName] ?? 0) + 1;
  }

  return {
    since: since.toISOString(),
    now: now.toISOString(),
    triggers: [...hooks.map((h) => {
      const config = (h.triggerConfig ?? {}) as { role?: unknown; intervalMinutes?: unknown };
      return {
        id: h.id,
        name: h.name,
        kind: h.trigger,
        action: h.action,
        href: '/hooks',
        state: null,
        enabled: h.isEnabled,
        role: typeof config.role === 'string' ? config.role : null,
        nextRunAt: h.nextRunAt ? h.nextRunAt.toISOString() : null,
        intervalMinutes: typeof config.intervalMinutes === 'number' ? config.intervalMinutes : null,
        lastExecutedAt: h.lastExecutedAt ? new Date(h.lastExecutedAt).toISOString() : null,
        lastError: h.lastError ?? null,
        events: (events.get(h.id) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
      };
    }), ...monitorsShown.map((m) => ({
      id: m.id,
      name: m.name,
      kind: 'monitor',
      action: m.role,
      href: `/chat?session=${encodeURIComponent(m.sessionId)}`,
      state: m.status,
      enabled: m.status === 'armed' || m.status === 'ready' || m.status === 'delivering',
      role: m.role,
      nextRunAt: m.status === 'armed' ? m.nextCheckAt.toISOString() : null,
      intervalMinutes: Math.max(1, Math.round(m.intervalSeconds / 60)),
      lastExecutedAt: m.lastCheckedAt ? m.lastCheckedAt.toISOString() : null,
      lastError: m.lastError ?? null,
      events: events.get(m.id) ?? [],
    })), ...goals.map((g) => ({
      id: g.id,
      name: g.title,
      kind: 'companion',
      action: 'dispatch to a project session',
      href: '/companion',
      state: g.state,
      enabled: !['completed', 'cancelled', 'paused'].includes(g.state),
      role: null,
      nextRunAt: null,
      intervalMinutes: null,
      lastExecutedAt: null,
      lastError: null,
      events: (events.get(g.id) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
    }))],
    funnel: { checks: checks.length, ran: checks.filter((c) => c.ran).length, skipped },
  };
}
