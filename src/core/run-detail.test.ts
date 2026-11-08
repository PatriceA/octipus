/**
 * The run view's read: the provenance chain (source, hook, the heartbeat
 * decision that ran, parent), the run tree, and the prompt — text from memory
 * when held, sizes from the row or user message otherwise.
 */
import { beforeEach, expect, test, vi } from 'vitest';

const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00Z`);
const composition = (label: string) => ({ version: 1, role: 'r', model: 'm', measuredAt: at('09:00').toISOString(),
  sections: [{ category: 'role', tier: 'static', label, tokens: 10, chars: 40 }], totals: { tokens: 10, chars: 40, prefixTokens: 10, turnTokens: 0, historyTokens: 0 } });
const fixture = vi.hoisted(() => ({ agents: new Map<string, Record<string, unknown>>(), inMemory: new Map<string, unknown>(), latest: undefined as unknown, stored: null as unknown }));
const agentRow = (id: string, extra: Record<string, unknown>) => ({ id, sessionId: 's', role: 'general', status: 'completed', createdAt: at('09:41'), parentAgentId: null, totalTokens: 0, metadata: {}, origin: null, ...extra });

vi.mock('@/db/repositories/content', () => ({ contentRepos: () => ({
  agents: {
    findById: async (id: string) => fixture.agents.get(id) ?? null,
    findBySession: async () => [...fixture.agents.values()],
    costByAgent: async () => new Map([['w', 0.12]]),
  },
  sessions: { findById: async () => ({ title: 'Release notes' }) },
  messages: { promptCompositionOf: async () => fixture.stored },
}) }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({
  hooks: {
    findById: async () => ({ id: 'hb', name: 'writing heartbeat', trigger: 'heartbeat' }),
    heartbeatChecksSince: async () => [
      { hookId: 'hb', checkedAt: at('08:40'), ran: true, readyTasks: 1 },
      { hookId: 'hb', checkedAt: at('09:40'), ran: true, readyTasks: 2 },
      { hookId: 'hb', checkedAt: at('10:40'), ran: true, readyTasks: 3 },
    ],
    companionGoalsOwn: async () => [],
  },
  pipelines: { findById: async () => null },
}) }));
vi.mock('./agent-manager', () => ({ getAgentManager: () => ({ get: () => undefined }) }));
vi.mock('./agent/prompt-composition', () => ({
  getAgentComposition: (id: string) => fixture.inMemory.get(id),
  getLatestComposition: () => fixture.latest,
}));
vi.mock('./run-outcome', () => ({ readRunOutcome: async (_a: unknown, root: boolean, status: string, cost: number | null) => ({ root, status, costUsd: cost }) }));
import { readRunDetail } from './run-detail';

const principal = { kind: 'user', userId: 'u' } as never;
beforeEach(() => { fixture.agents.clear(); fixture.inMemory.clear(); fixture.latest = undefined; fixture.stored = null; });

test('another user\'s run, or a missing one, reads as not found', async () => {
  expect(await readRunDetail(principal, 'nope')).toBeNull();
});

test('a heartbeat worker: chain from hook to the decision that ran at its start, its parent, its children', async () => {
  fixture.agents.set('root', agentRow('root', { metadata: { root: true } }));
  fixture.agents.set('w', agentRow('w', { role: 'writing', parentAgentId: 'root', origin: { source: 'heartbeat', channel: 'heartbeat', hookId: 'hb' },
    metadata: { promptComposition: composition('writing role prompt') } }));
  fixture.agents.set('c', agentRow('c', { role: 'research', parentAgentId: 'w', totalTokens: 1200, status: 'running' }));

  const r = await readRunDetail(principal, 'w');
  expect(r?.chain.map((s) => [s.kind, s.label, s.detail])).toEqual([
    ['source', 'Heartbeat', 'heartbeat'],
    ['hook', 'writing heartbeat', 'heartbeat'],
    ['heartbeat', 'Heartbeat check passed', '2 ready to-dos'],
    ['parent', 'Octipus', 'spawned this run'],
  ]);
  expect(r).toMatchObject({ sessionTitle: 'Release notes', parent: { id: 'root', root: true }, children: [{ id: 'c', role: 'research', status: 'running', totalTokens: 1200 }] });
  expect(r?.prompt).toMatchObject({ textAvailable: false, sections: [{ label: 'writing role prompt' }] });
  expect(r?.outcome).toEqual({ root: false, status: 'completed', costUsd: 0.12 });
});

test('the prompt comes from memory with text while held, else from what was stored', async () => {
  fixture.agents.set('w', agentRow('w', { role: 'writing', metadata: { promptComposition: composition('stored') } }));
  fixture.inMemory.set('w', composition('in memory'));
  expect((await readRunDetail(principal, 'w'))?.prompt).toMatchObject({ textAvailable: true, sections: [{ label: 'in memory' }] });

  fixture.agents.set('root', agentRow('root', { metadata: { root: true } }));
  fixture.latest = { agentId: 'another-root', composition: composition('later turn') };
  fixture.stored = composition('user message');
  expect((await readRunDetail(principal, 'root'))?.prompt).toMatchObject({ textAvailable: false, sections: [{ label: 'user message' }] });
  fixture.latest = { agentId: 'root', composition: composition('latest turn') };
  expect((await readRunDetail(principal, 'root'))?.prompt).toMatchObject({ textAvailable: true, sections: [{ label: 'latest turn' }] });
});

test('a run from before origins were recorded has an empty chain and no prompt', async () => {
  fixture.agents.set('old', agentRow('old', {}));
  expect(await readRunDetail(principal, 'old')).toMatchObject({ chain: [], prompt: null, parent: null, children: [] });
});
