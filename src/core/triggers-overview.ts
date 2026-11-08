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
  const hooks = await repo.listOwn();
  const ids = hooks.map((h) => h.id);
  const [checks, executions] = await Promise.all([repo.heartbeatChecksSince(ids, since), repo.executionsSince(ids, since)]);

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

  const skipped: Partial<Record<HeartbeatSkipReasonName, number>> = {};
  for (const c of checks) {
    if (!c.ran && c.reason) skipped[c.reason as HeartbeatSkipReasonName] = (skipped[c.reason as HeartbeatSkipReasonName] ?? 0) + 1;
  }

  return {
    since: since.toISOString(),
    now: now.toISOString(),
    triggers: hooks.map((h) => {
      const config = (h.triggerConfig ?? {}) as { role?: unknown; intervalMinutes?: unknown };
      return {
        hookId: h.id,
        name: h.name,
        kind: h.trigger,
        action: h.action,
        enabled: h.isEnabled,
        role: typeof config.role === 'string' ? config.role : null,
        nextRunAt: h.nextRunAt ? h.nextRunAt.toISOString() : null,
        intervalMinutes: typeof config.intervalMinutes === 'number' ? config.intervalMinutes : null,
        lastExecutedAt: h.lastExecutedAt ? new Date(h.lastExecutedAt).toISOString() : null,
        lastError: h.lastError ?? null,
        events: (events.get(h.id) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
      };
    }),
    funnel: { checks: checks.length, ran: checks.filter((c) => c.ran).length, skipped },
  };
}
