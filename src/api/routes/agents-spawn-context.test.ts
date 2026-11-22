/**
 * `POST /api/agents` with a message runs the caller's task in their own
 * session: the context hooks' block goes before the message, the record is
 * the agent's and is finished, and a room gets none. `contextForAgentStart`
 * is real; the hooks, the session row and the agent are stood in for.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const USER = '55555555-5555-5555-5555-555555555555';
const BLOCK = '\n\n<recalled-knowledge>\nThe release checklist.\n</recalled-knowledge>\n';
const fx = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  runs: [] as string[],
  hooks: vi.fn(),
  finish: vi.fn(),
  turn: { id: 'turn-api', usageKey: 's', startUse: { knowledge: 0, notes: 0 }, citable: [] },
  hooksBeforeSpawn: [] as number[],
  spawnError: undefined as Error | undefined,
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: { id: USER, isAdmin: false }, principal: { kind: 'user', userId: USER } })) };
});
vi.mock('@/security/principal', async (original) => ({ ...await original<typeof import('@/security/principal')>(), isAuthenticated: (p: unknown) => !!p }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async (id: string) => ({ id, userId: USER, ...fx.session }) } }));
vi.mock('@/core/rooms/access', () => ({ canActInSession: async () => true }));
vi.mock('@/core/agent/context', async (original) => ({
  ...await original<object>(),
  resolveAgentScope: async () => ({ workspaceId: 'ws', space: null, sponsor: null, trigger: 'user', funding: 'own' }),
  withAgentUsage: (_u: string, _s: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/security/workspace-fs', async (original) => ({ ...await original<object>(), isSharedWorkspaceId: async () => false }));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({
    spawn: async () => {
      // How many hook runs had happened when the spawn chose its model.
      fx.hooksBeforeSpawn.push(fx.hooks.mock.calls.length);
      if (fx.spawnError) throw fx.spawnError;
      return spawned();
    },
  }),
}));
const spawned = () => ({
  run: async (message: string) => { fx.runs.push(message); return 'done'; },
  getContext: () => ({ id: 'agent-api', sessionId: 'sess-api', topic: 'general', model: 'm', role: 'general' }),
  getStatus: () => 'idle',
});
vi.mock('@/core/context-hooks/run', async (original) => ({
  ...await original<object>(),
  runContextHooks: (...args: unknown[]) => fx.hooks(...args),
  finishContextTurn: (...args: unknown[]) => fx.finish(...args),
}));
const { agentRoutes } = await import('./agents');

const app = new App().group('/api', (route) => route.use(agentRoutes));
const spawn = (message: string) => app.handle(new Request('http://test/api/agents', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-api', message }),
}));

beforeEach(() => {
  fx.session = {};
  fx.hooksBeforeSpawn = [];
  fx.spawnError = undefined;
  fx.runs = [];
  fx.hooks.mockReset().mockResolvedValue({ text: BLOCK, blocks: [BLOCK], labelledBlocks: [], repeatable: [], turn: fx.turn });
  fx.finish.mockReset();
});

test("the caller's task gets the block before its message; the record is the agent's and is finished", async () => {
  expect((await spawn('prepare the release')).status).toBe(200);
  await vi.waitFor(() => expect(fx.finish).toHaveBeenCalledTimes(1));
  expect(fx.hooks.mock.calls[0][0]).toMatchObject({ event: 'worker_start', userId: USER, workspaceId: 'ws', sessionId: 'sess-api', query: 'prepare the release', channel: 'api' });
  expect(fx.runs).toEqual([`${BLOCK.trim()}\n\nprepare the release`]);
  expect(fx.turn.usageKey).toBe('agent:agent-api');
  expect(fx.finish).toHaveBeenCalledWith(fx.turn, { agentId: 'agent-api', response: 'done', outcome: 'success' });
});

test('in a room: no hooks, the message as sent', async () => {
  fx.session = { kind: 'room' };
  expect((await spawn('prepare the release')).status).toBe(200);
  await vi.waitFor(() => expect(fx.runs).toHaveLength(1));
  expect(fx.hooks).not.toHaveBeenCalled();
  expect(fx.runs).toEqual(['prepare the release']);
});

test('the hooks run before the spawn: the model is chosen at the level what they show raised', async () => {
  expect((await spawn('summarise the contract')).status).toBe(200);
  expect(fx.hooksBeforeSpawn).toEqual([1]);
});

test('a spawn refused after the hooks ran closes their record', async () => {
  fx.spawnError = new Error('This conversation holds confidential content (protection level 3), which stays on local models, and no local model is bound.');
  const res = await spawn('summarise the contract');
  expect(await res.json()).toEqual({ error: fx.spawnError.message });
  await vi.waitFor(() => expect(fx.finish).toHaveBeenCalledWith(fx.turn, { outcome: 'error' }));
  expect(fx.runs).toEqual([]);
});
