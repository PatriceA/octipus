/**
 * A swarm child's context hooks (`spawn_child`): the block for its brief is
 * in the child's first message, a fork gets none of its own, the audience
 * rule holds, and the record is bound to the child and closed on every way
 * the child ends.
 *
 * `spawnChild` runs for real up to the hand-off to `runChildWithRetry`,
 * which is instance-patched (as in spawner-lane-availability.test.ts), so
 * what is asserted is what the child's attempts are handed.
 * `contextForAgentStart` and `bindTurnToAgent` are real; the hooks
 * themselves and the record's database write are stood in for.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { agentUsageKey } from '@/core/context-hooks/tool-usage';

const USER = '44444444-4444-4444-4444-444444444444';
const SESSION = '00000000-0000-0000-0000-0000000000cc';
const BLOCK = '\n\n<recalled-knowledge>\nEnterprise hosting: 99 euro a month.\n</recalled-knowledge>\n';
type Turn = { id: string; usageKey: string; startUse: { knowledge: number; notes: number }; citable: [] };
const fx = vi.hoisted(() => ({
  hooks: vi.fn(),
  finish: vi.fn(),
  session: {} as Record<string, unknown>,
}));
vi.mock('@/core/context-hooks/run', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runContextHooks: (...args: unknown[]) => fx.hooks(...args),
  finishContextTurn: (...args: unknown[]) => fx.finish(...args),
}));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async (id: string) => ({ id, userId: USER, ...fx.session }) } }));
vi.mock('@/security/workspace-fs', async (importOriginal) => ({ ...(await importOriginal<object>()), isSharedWorkspaceId: async () => false }));
vi.mock('./spawn-cache', () => ({ lookupCacheHit: async () => null }));
vi.mock('@/skills/registry', () => ({ getSkillRegistry: () => ({ getByIds: async () => [], buildPromptSummary: async () => '' }) }));
vi.mock('@/skills/discovery', () => ({ discoverSkillIds: async () => [] }));
vi.mock('@/security/credential-redaction', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  redactAgentDiagnostics: async (_u: string, _w: string | null, data: unknown) => data,
}));
const row = { modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' };
vi.mock('@/models/model-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModelRegistry: () => ({ getModel: async () => row, getModelByModelId: async () => null }),
}));
vi.mock('@/models/resolve-model', async (importOriginal) => ({ ...(await importOriginal<object>()), resolveModel: async () => row }));

const { SwarmSpawner } = await import('./spawner');
const { __resetCallGraphsForTests } = await import('./call-graph');
const { LEVEL_DEFAULT } = await import('./types');
type AgentNode = import('./types').AgentNode;
type ChildResult = import('./types').ChildResult;

function parentNode(): AgentNode {
  return {
    id: 'root-hooks', rootSessionId: SESSION, userId: USER, parentNodeId: null, kind: 'root', depth: 0, role: 'general',
    topicPath: 'root', model: 'test-model',
    budget: { tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 }, wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() }, fanOut: { cap: 4, used: 0 }, depth: 0 },
    allowedToolIds: new Set<string>(), signal: new AbortController().signal,
  };
}
const parentContext = () => ({
  id: 'ctx-hooks', sessionId: SESSION, userId: USER, workspaceId: 'ws', topic: 'x', model: 'test-model', role: 'general' as const,
  status: 'running' as const, space: null, trigger: 'user' as const, funding: 'own' as const, createdAt: new Date(), updatedAt: new Date(), metadata: {},
});
const params = (over: Record<string, unknown> = {}) => ({
  role: 'research', topic: 'pricing', subtopic: 'enterprise', taskBrief: 'Find what we charge enterprise customers for hosting', expectedOutput: { shape: 'summary' as const }, ...over,
});

type Opts = {
  childMessage: string;
  fork?: object;
  ordinary?: { childMessage: string };
  onWorkerStarted?: (id: string) => void;
  childContext?: { turn: Turn | null; forOrdinary?: () => Promise<string> };
};
/** A spawner whose child "runs": reports its worker, then ends as `end` says. */
function spawner(runs: Opts[], end: (opts: Opts) => Promise<ChildResult> = async () =>
  ({ nodeId: 'child-1', kind: 'agent', status: 'ok', output: '99 euro a month', usedTokens: 0, durationMs: 1, spawnedChildren: [] })) {
  const s = new SwarmSpawner({ publishEvent: () => {} } as never);
  (s as unknown as Record<string, unknown>).runChildWithRetry = async (opts: Opts) => {
    runs.push(opts);
    opts.onWorkerStarted?.('child-1');
    return end(opts);
  };
  return s;
}
const forkSeed = { messages: [], tools: [], model: 'parent-model', modelName: 'parent-model', cacheScope: 'scope', cachePacing: {} };

let turn: Turn;
beforeEach(() => {
  __resetCallGraphsForTests();
  fx.session = {};
  turn = { id: 'turn-child', usageKey: SESSION, startUse: { knowledge: 0, notes: 0 }, citable: [] };
  fx.hooks.mockReset().mockImplementation(async () => ({ text: BLOCK, blocks: [BLOCK], labelledBlocks: [], repeatable: [], turn }));
  fx.finish.mockReset();
});

describe('a swarm child', () => {
  test("its brief is searched and the block is in its first message, after the brief; the record is the child's", async () => {
    const runs: Opts[] = [];
    const result = await spawner(runs).spawnChild(parentNode(), params() as never, parentContext() as never);
    expect(result.status).toBe('ok');
    expect(fx.hooks).toHaveBeenCalledTimes(1);
    expect(fx.hooks.mock.calls[0][0]).toMatchObject({
      event: 'worker_start', userId: USER, workspaceId: 'ws', sessionId: SESSION, query: params().taskBrief, role: 'research',
    });
    // A brief is self-contained: no previous message.
    expect(fx.hooks.mock.calls[0][0]).not.toHaveProperty('previousMessage');
    const message = runs[0].childMessage;
    expect(message).toContain(BLOCK.trim());
    expect(message.indexOf(params().taskBrief)).toBeLessThan(message.indexOf('<recalled-knowledge>'));
    // Bound to the child: its own tool calls count, not its root's or siblings'.
    expect(turn.usageKey).toBe(agentUsageKey('child-1'));
    expect(fx.finish).toHaveBeenCalledWith(turn, { agentId: 'child-1', response: '99 euro a month', outcome: 'success' });
  });

  test('a fork gets no block of its own; only an attempt run as the ordinary child runs the hooks, once', async () => {
    const runs: Opts[] = [];
    await spawner(runs).spawnChild(parentNode(), params({ fork: true }) as never, parentContext() as never, { forkSeed } as never);
    expect(runs[0].fork).toBeDefined();
    expect(runs[0].childMessage).not.toContain('recalled-knowledge');
    expect(runs[0].ordinary?.childMessage).not.toContain('recalled-knowledge');
    expect(fx.hooks).not.toHaveBeenCalled();
    // Nothing ran, nothing to close.
    expect(fx.finish).toHaveBeenCalledWith(null, expect.anything());

    const forOrdinary = runs[0].childContext?.forOrdinary;
    expect(await forOrdinary?.()).toBe(BLOCK.trim());
    expect(await forOrdinary?.()).toBe(BLOCK.trim());
    expect(fx.hooks).toHaveBeenCalledTimes(1);
    expect(runs[0].childContext?.turn).toBe(turn);
  });

  test('in a room or a group thread: no hooks', async () => {
    for (const session of [{ kind: 'room' }, { groupChannelId: 'g1' }]) {
      fx.session = session;
      __resetCallGraphsForTests();
      const runs: Opts[] = [];
      await spawner(runs).spawnChild(parentNode(), params() as never, parentContext() as never);
      expect(runs[0].childMessage).not.toContain('recalled-knowledge');
    }
    expect(fx.hooks).not.toHaveBeenCalled();
  });

  test('a child that never started closes the record without an agent', async () => {
    const runs: Opts[] = [];
    await spawner(runs, async () => ({ nodeId: '', kind: 'agent', status: 'concurrency_limit', output: null, usedTokens: 0, durationMs: 1, spawnedChildren: [] }))
      .spawnChild(parentNode(), params() as never, parentContext() as never);
    expect(fx.finish).toHaveBeenCalledWith(turn, { response: '', outcome: 'concurrency_limit' });
  });

  test('a child that throws, or is cancelled, closes the record too', async () => {
    await expect(spawner([], async () => { throw new Error('worktree exploded'); })
      .spawnChild(parentNode(), params() as never, parentContext() as never)).rejects.toThrow('worktree exploded');
    expect(fx.finish).toHaveBeenCalledWith(turn, { outcome: 'error' });

    __resetCallGraphsForTests();
    fx.finish.mockReset();
    await spawner([], async () => ({ nodeId: 'child-1', kind: 'agent', status: 'cancelled', output: null, usedTokens: 0, durationMs: 1, spawnedChildren: [] }))
      .spawnChild(parentNode(), params() as never, parentContext() as never);
    expect(fx.finish).toHaveBeenCalledWith(turn, { agentId: 'child-1', response: '', outcome: 'cancelled' });
  });
});
