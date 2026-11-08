/**
 * The sidebar pulse counts the user's running workers that their scoped
 * repository can see (not another workspace's), and their pending approvals;
 * approvals that cannot be read are null, not zero.
 */
import { beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ visible: new Set<string>(), pending: [] as unknown[] | Error }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ list: () => [
  { id: 'mine', userId: 'u', status: 'running' },
  { id: 'other-workspace', userId: 'u', status: 'running' },
  { id: 'done', userId: 'u', status: 'completed' },
  { id: 'someone-else', userId: 'v', status: 'running' },
] }) }));
vi.mock('@/db/repositories/content', () => ({ contentRepos: () => ({ agents: { findById: async (id: string) => (fixture.visible.has(id) ? { id } : null) } }) }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({}) }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ getPendingRequests: async () => {
  if (fixture.pending instanceof Error) throw fixture.pending;
  return fixture.pending;
} }) }));
import { readAgentPulse } from './mission-control';

const principal = { kind: 'user', userId: 'u' } as never;
beforeEach(() => { fixture.visible = new Set(['mine', 'done', 'someone-else']); fixture.pending = [{}, {}]; });

test('counts own running workers the scope can see, and pending approvals', async () => {
  expect(await readAgentPulse(principal, 'u')).toEqual({ live: 1, pendingApprovals: 2 });
});

test('approvals that cannot be read are null', async () => {
  fixture.pending = new Error('db down');
  expect(await readAgentPulse(principal, 'u')).toEqual({ live: 1, pendingApprovals: null });
});
