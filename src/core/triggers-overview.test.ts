/**
 * The Triggers page's read: heartbeat decisions and executions merged per
 * hook, a heartbeat's successful execution not counted twice, and the
 * funnel counted from the decisions.
 */
import { beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ hooks: [] as unknown[], checks: [] as unknown[], executions: [] as unknown[], monitors: [] as unknown[], goals: [] as unknown[], actions: [] as unknown[] }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({ hooks: {
  listOwn: async () => fixture.hooks,
  heartbeatChecksSince: async () => fixture.checks,
  executionsSince: async () => fixture.executions,
  monitorsOwn: async () => fixture.monitors,
  companionGoalsOwn: async () => fixture.goals,
  companionActionsSince: async () => fixture.actions,
} }) }));
vi.mock('./mission-control', () => ({ startOfToday: () => new Date('2026-11-08T00:00:00Z') }));
import { readTriggers } from './triggers-overview';

const hook = (over: Record<string, unknown>) => ({
  name: 'h', action: 'spawn_agent', isEnabled: true, triggerConfig: {}, nextRunAt: null, lastExecutedAt: null, lastError: null, ...over,
});
const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00Z`);

beforeEach(() => {
  fixture.monitors = [];
  fixture.goals = [];
  fixture.actions = [];
  fixture.hooks = [
    hook({ id: 'hb', name: 'writer heartbeat', trigger: 'heartbeat', triggerConfig: { role: 'writer', intervalMinutes: 60 }, nextRunAt: at('10:40') }),
    hook({ id: 'cron', name: 'Daily briefing', trigger: 'schedule' }),
  ];
  fixture.checks = [
    { hookId: 'hb', checkedAt: at('07:40'), ran: false, reason: 'nothing_pending', readyTasks: 0 },
    { hookId: 'hb', checkedAt: at('08:40'), ran: false, reason: 'quiet_hours', readyTasks: null },
    { hookId: 'hb', checkedAt: at('09:40'), ran: true, reason: null, readyTasks: 2 },
  ];
  fixture.executions = [
    { hookId: 'hb', status: 'success', error: null, createdAt: at('09:40') },
    { hookId: 'cron', status: 'success', error: null, createdAt: at('07:30') },
    { hookId: 'cron', status: 'error', error: 'gh auth expired', createdAt: at('08:12') },
    { hookId: 'cron', status: 'skipped', error: null, createdAt: at('08:30') },
  ];
});

test('heartbeat decisions, executions and the funnel', async () => {
  const r = await readTriggers({ kind: 'user', userId: 'u' } as never, at('10:05'));
  const [hb, cron] = r.triggers;
  expect(hb).toMatchObject({ role: 'writer', intervalMinutes: 60, nextRunAt: '2026-11-08T10:40:00.000Z' });
  // The heartbeat's own successful execution is its "ran" check, not a second event.
  expect(hb.events.map((e) => [e.kind, e.reason, e.readyTasks])).toEqual([
    ['skipped', 'nothing_pending', 0], ['skipped', 'quiet_hours', null], ['ran', null, 2],
  ]);
  // A schedule's executions; a skipped execution is not an event.
  expect(cron.events.map((e) => [e.kind, e.reason])).toEqual([['ran', null], ['failed', 'gh auth expired']]);
  expect(r.funnel).toEqual({ checks: 3, ran: 1, skipped: { nothing_pending: 1, quiet_hours: 1 } });
});

test('monitors and Companion goals are triggers too; finished ones from before today are not', async () => {
  fixture.monitors = [
    { id: 'mon', name: 'PR 412 checks', role: 'general', status: 'armed', intervalSeconds: 1800, nextCheckAt: at('11:30'), lastCheckedAt: at('10:00'), deadline: at('23:00'), lastError: null, sessionId: 's1', sessionTitle: 'Release' },
    { id: 'old', name: 'Done last week', role: 'general', status: 'completed', intervalSeconds: 600, nextCheckAt: at('01:00'), lastCheckedAt: new Date('2026-11-01T10:00:00Z'), deadline: at('02:00'), lastError: null, sessionId: 's2', sessionTitle: null },
  ];
  fixture.goals = [
    { id: 'goal', title: 'Vendor pricing', state: 'active', updatedAt: at('09:20') },
    { id: 'done', title: 'Shipped long ago', state: 'completed', updatedAt: new Date('2026-11-01T10:00:00Z') },
  ];
  fixture.actions = [
    { goalId: 'goal', kind: 'start_session', status: 'completed', createdAt: at('09:05') },
    { goalId: 'goal', kind: 'message_session', status: 'failed', createdAt: at('09:20') },
    { goalId: 'goal', kind: 'message_session', status: 'queued', createdAt: at('09:30') },
  ];
  const r = await readTriggers({ kind: 'user', userId: 'u' } as never, at('10:05'));
  const monitor = r.triggers.find((t) => t.id === 'mon');
  expect(monitor).toMatchObject({ kind: 'monitor', state: 'armed', enabled: true, intervalMinutes: 30, nextRunAt: '2026-11-08T11:30:00.000Z', href: '/chat?session=s1' });
  expect(monitor?.events.map((e) => e.kind)).toEqual(['skipped']);
  const goal = r.triggers.find((t) => t.id === 'goal');
  expect(goal).toMatchObject({ kind: 'companion', state: 'active', href: '/companion' });
  expect(goal?.events.map((e) => [e.kind, e.reason])).toEqual([['ran', 'start session'], ['failed', 'message session: failed']]);
  expect(r.triggers.map((t) => t.id)).not.toContain('old');
  expect(r.triggers.map((t) => t.id)).not.toContain('done');
  // The heartbeat funnel counts heartbeat decisions only.
  expect(r.funnel.checks).toBe(3);
});
