/**
 * The Triggers page's read: heartbeat decisions and executions merged per
 * hook, a heartbeat's successful execution not counted twice, and the
 * funnel counted from the decisions.
 */
import { beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ hooks: [] as unknown[], checks: [] as unknown[], executions: [] as unknown[] }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({ hooks: {
  listOwn: async () => fixture.hooks,
  heartbeatChecksSince: async () => fixture.checks,
  executionsSince: async () => fixture.executions,
} }) }));
vi.mock('./mission-control', () => ({ startOfToday: () => new Date('2026-11-08T00:00:00Z') }));
import { readTriggers } from './triggers-overview';

const hook = (over: Record<string, unknown>) => ({
  name: 'h', action: 'spawn_agent', isEnabled: true, triggerConfig: {}, nextRunAt: null, lastExecutedAt: null, lastError: null, ...over,
});
const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00Z`);

beforeEach(() => {
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
