import { expect, it, vi } from 'vitest';
import { createSteerChildTool } from './steer-tool';
import { createSpawnChildTool } from './swarm-tool';
import { LEVEL_DEFAULT, type AgentNode, type ChildResult, type PendingChild } from './types';
import type { SpawnChildInternalOpts, SwarmSpawner } from './spawner';
import type { AgentWorker } from '@/core/agent-worker';
const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => state }));

const parentNode: AgentNode = {
  id: 'agent-1',
  rootSessionId: 's',
  userId: 'u',
  parentNodeId: 'root-0',
  kind: 'agent',
  depth: 1,
  role: 'research',
  topicPath: 'root/research',
  model: 'test-model',
  budget: {
    tokens: { cap: LEVEL_DEFAULT[1].tokens, used: 0 },
    wallClockMs: { cap: LEVEL_DEFAULT[1].wallMs, startedAt: Date.now() },
    fanOut: { cap: LEVEL_DEFAULT[1].fanOut, used: 0 },
    depth: 1,
  },
  allowedToolIds: new Set(['spawn_child', 'steer_child']),
  signal: new AbortController().signal,
};

/**
 * Detach a child through the real `spawn_child` tool. The spawner stub reports
 * the child's worker the way `singleSpawnAndRun` does — under the agent id the
 * manager knows, which is NOT the handle the parent was given.
 */
async function spawnDetached(childAgentId: string): Promise<PendingChild[]> {
  const pending: PendingChild[] = [];
  let release!: (r: ChildResult) => void;
  const spawner = {
    spawnChild: (_p: unknown, _params: unknown, _ctx: unknown, internal: SpawnChildInternalOpts) => {
      internal.onWorkerStarted?.(childAgentId);
      return new Promise<ChildResult>(resolve => { release = resolve; });
    },
  } as unknown as SwarmSpawner;
  const tool = createSpawnChildTool(parentNode, spawner, {
    registerPending: pc => pending.push(pc),
    pendingCount: () => pending.length,
    maxPendingDetached: () => 3,
  });
  await tool.execute(
    { topic: 'research', subtopic: 'x', taskBrief: 'Summarize source 1', expectedOutput: { shape: 'summary' }, mode: 'detach' },
    { space: null, trigger: 'user', funding: 'own', id: 'ctx', sessionId: 's', userId: 'u', model: '', topic: '', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
  );
  release({ nodeId: childAgentId, kind: 'subagent', status: 'ok', output: 'done', usedTokens: 0, durationMs: 1, spawnedChildren: [] });
  return pending;
}

it('steers the child spawn_child started, found by its agent id rather than the handle', async () => {
  const pending = await spawnDetached('child-agent-7');
  expect(pending).toHaveLength(1);
  const handle = pending[0].childId;
  expect(handle).not.toBe('child-agent-7');

  const steer = vi.fn();
  const child = { getContext: () => ({ userId: 'u', sessionId: 's' }), getStatus: () => 'running', steer };
  // Only the real agent id resolves, as in AgentManager.
  state.get.mockImplementation((id: string) => (id === 'child-agent-7' ? child : undefined));
  const parent = { listPendingDetached: () => pending, getContext: () => ({ userId: 'u', sessionId: 's' }) } as unknown as AgentWorker;
  const tool = createSteerChildTool({ current: parent });
  const invoke = (args: Record<string, unknown>) => tool.execute(args, {} as never);

  expect(await invoke({ childId: 'unrelated', message: 'change' })).toContain('not pending under you');
  expect(steer).not.toHaveBeenCalled();
  expect(await invoke({ childId: handle, message: 'adjust your scope' })).toContain('Guidance queued');
  expect(steer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'user', content: 'adjust your scope' }));
  steer.mockClear();
  state.get.mockReturnValue({ ...child, getStatus: () => 'completed' });
  expect(await invoke({ childId: handle, message: 'change' })).toContain('follow-up');
  expect(steer).not.toHaveBeenCalled();
  state.get.mockReturnValue({ ...child, getContext: () => ({ userId: 'other', sessionId: 's' }) });
  expect(await invoke({ childId: handle, message: 'change' })).toContain('unavailable');
  expect(steer).not.toHaveBeenCalled();
});

it('says a pending child whose worker has not started yet cannot be steered', async () => {
  state.get.mockReset();
  const parent = {
    listPendingDetached: () => [{ childId: 'h1' }],
    getContext: () => ({ userId: 'u', sessionId: 's' }),
  } as unknown as AgentWorker;
  const tool = createSteerChildTool({ current: parent });
  expect(await tool.execute({ childId: 'h1', message: 'change' }, {} as never)).toContain('not started running yet');
  expect(state.get).not.toHaveBeenCalled();
});
