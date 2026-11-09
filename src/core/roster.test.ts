/**
 * The Roster read: every registered role plus any role only seen on to-dos
 * or hooks, with heartbeat state, today's runs and the latest decision; the
 * root first, then roles doing something.
 */
import { expect, test, vi } from 'vitest';

const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00Z`);
vi.mock('./agent/roles', () => ({ ROLE_CONFIGS: {
  general: { toolIds: ['a', 'b'], defaultTopic: 'everyday', description: 'Root' },
  writing: { toolIds: ['a'], defaultTopic: 'writing', description: 'Drafts', readOnly: false },
  research: { toolIds: ['a', 'b', 'c'], defaultTopic: 'research', description: 'Finds sources', readOnly: true },
} }));
vi.mock('./tasks/role-agents', () => ({ listRoleAgents: async () => ({
  roles: [
    { role: 'writing', activeTasks: 2, totalTasks: 5, enabled: true, hookId: 'hb-w', known: true, pipelineTemplate: null },
    { role: 'retired', activeTasks: 1, totalTasks: 1, enabled: false, hookId: null, known: false, pipelineTemplate: null },
  ],
  boardWritesAllowed: true, heartbeatEnabled: true,
}) }));
vi.mock('@/db/repositories/content', () => ({ contentRepos: () => ({ agents: { listOwnSince: async () => [
  { id: 'w2', role: 'writing', status: 'running', createdAt: at('09:41'), sessionTitle: 'Release notes', origin: { source: 'heartbeat' } },
  { id: 'w1', role: 'writing', status: 'completed', createdAt: at('08:40'), sessionTitle: 'Reply draft', origin: { source: 'heartbeat' } },
] } }) }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({ hooks: {
  listOwn: async () => [
    { id: 'personal', trigger: 'heartbeat', isEnabled: true, nextRunAt: at('10:15'), triggerConfig: { intervalMinutes: 15 } },
    { id: 'hb-w', trigger: 'heartbeat', isEnabled: true, nextRunAt: at('10:40'), triggerConfig: { role: 'writing', intervalMinutes: 60 } },
  ],
  heartbeatChecksSince: async () => [
    { hookId: 'personal', checkedAt: at('10:00'), ran: false, reason: 'nothing_pending' },
    { hookId: 'hb-w', checkedAt: at('08:40'), ran: true, reason: null },
    { hookId: 'hb-w', checkedAt: at('09:40'), ran: false, reason: 'in_flight' },
  ],
} }) }));
vi.mock('./agent-manager', () => ({ getAgentManager: () => ({ get: () => undefined }) }));
vi.mock('./mission-control', () => ({ startOfToday: () => at('00:00') }));
import { readRoster } from './roster';

test('roles as agents: state, to-dos, runs and the latest heartbeat decision', async () => {
  const r = await readRoster({ kind: 'user', userId: 'u' } as never, 'u', at('10:05'));
  expect(r.roles.map((x) => x.role)).toEqual(['general', 'writing', 'retired', 'research']);
  const writing = r.roles[1];
  expect(writing).toMatchObject({
    lane: 'writing', toolGroups: 1, known: true,
    heartbeat: { enabled: true, nextCheckAt: '2026-11-08T10:40:00.000Z', intervalMinutes: 60, lastCheck: { ran: false, reason: 'in_flight' } },
    tasks: { active: 2, total: 5 }, runsToday: 2, liveRuns: 1,
    lastRun: { id: 'w2', status: 'running', title: 'Release notes', source: 'heartbeat' },
  });
  expect(r.roles[0]).toMatchObject({ root: true, runsToday: 0, lastRun: null, heartbeat: { enabled: true, hookId: 'personal', intervalMinutes: 15, nextCheckAt: '2026-11-08T10:15:00.000Z', lastCheck: { reason: 'nothing_pending' } } });
  // A role only seen on old to-dos is listed, and says it is not registered.
  expect(r.roles.find((x) => x.role === 'retired')).toMatchObject({ known: false, toolGroups: 0, tasks: { active: 1 } });
  expect(r.roles.find((x) => x.role === 'research')).toMatchObject({ readOnly: true, heartbeat: { enabled: false, nextCheckAt: null } });
});
