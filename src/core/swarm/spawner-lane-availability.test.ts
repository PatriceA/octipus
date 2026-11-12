/**
 * `spawnChild` up to the hand-off to `runChildWithRetry`: the routePolicy
 * mismatch denial and the pre-spawn availability check (lane-availability.ts).
 *
 * No DB: the session read, the model registry and `resolveModel` are
 * module-mocked; `resolveChildModel` and `runChildWithRetry` are
 * instance-patched, so what is asserted is the decision between them.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const rows: Record<string, { modelId: string; name: string; provider: string }> = {
  'gpt-x': { modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' },
  'claude-y': { modelId: 'claude-y', name: 'claude-y', provider: 'anthropic' },
};
let backupRow: { modelId: string; name: string; provider: string } | null = null;

vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => null } }));
vi.mock('./spawn-cache', () => ({ lookupCacheHit: async () => null }));
vi.mock('@/models/model-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModelRegistry: () => ({
    getModel: async (name: string) => rows[name] ?? null,
    getModelByModelId: async () => null,
  }),
}));
vi.mock('@/models/resolve-model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModel: async (req: { backup?: boolean }) => (req.backup ? backupRow : null),
}));

const { SwarmSpawner } = await import('./spawner');
const { __resetCallGraphsForTests, getCallGraph } = await import('./call-graph');
const { getCircuitBreakerRegistry, resetCircuitBreakerRegistry } = await import('@/models/circuit-breaker');
const { LEVEL_DEFAULT } = await import('./types');
type AgentNode = import('./types').AgentNode;
type DelegationAttempt = import('./attempt-history').DelegationAttempt;

function makeNode(): AgentNode {
  return {
    id: 'root-lanes', rootSessionId: '00000000-0000-0000-0000-0000000000bb', userId: 'user-1',
    parentNodeId: null, kind: 'root', depth: 0, role: 'general', topicPath: 'root', model: 'test-model',
    budget: {
      tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
      wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
      fanOut: { cap: 4, used: 0 },
      depth: 0,
    },
    allowedToolIds: new Set<string>(),
    signal: new AbortController().signal,
  };
}

const ctx = () => ({
  id: 'ctx-lanes', sessionId: '00000000-0000-0000-0000-0000000000bb', userId: 'user-1', topic: 'x',
  model: 'test-model', role: 'general' as const, status: 'running' as const, space: null,
  trigger: 'user' as const, funding: 'own' as const, createdAt: new Date(), updatedAt: new Date(), metadata: {},
});

type RunOpts = { childModel: string; childModelName: string; route?: string; requestedModel: string; attempts: DelegationAttempt[] };

function makeSpawner(runs: RunOpts[]) {
  const spawner = new SwarmSpawner({ publishEvent: () => {} } as never);
  const s = spawner as unknown as Record<string, unknown>;
  s.resolveChildModel = async () => ({
    model: 'gpt-x', modelName: 'gpt-x', lane: 'build', systemPrompt: 'you are a coder', skillContext: '', isSmall: false,
  });
  s.runChildWithRetry = async (opts: RunOpts) => {
    runs.push(opts);
    return { nodeId: 'child-1', kind: 'agent', status: 'ok', output: 'done', usedTokens: 0, durationMs: 1, spawnedChildren: [] };
  };
  return spawner;
}

const params = (over: Record<string, unknown> = {}) => ({
  role: 'coding', topic: 'build', subtopic: 'fix', taskBrief: 'fix the parser bug', expectedOutput: { shape: 'summary' as const }, ...over,
});

/** Whether the brief's fingerprint was released: a second identical spawn is not a duplicate. */
function fingerprintReleased(parent: AgentNode, p: ReturnType<typeof params>, result: { status: string }): void {
  expect(result.status).toBe('denied');
  const graph = getCallGraph(parent.rootSessionId);
  const brief = {
    originalUserRequest: p.taskBrief, topicPath: 'root / build / fix', parentSummary: '', ancestry: [],
    taskBrief: p.taskBrief, constraints: [], inputArtifacts: [],
    expectedOutput: { shape: 'summary' as const, schema: undefined, maxTokens: 2000 }, forbidden: [], plan: undefined,
  };
  expect(() => graph.checkSpawn(parent.id, brief)).not.toThrow();
  // …and it is the same brief: now that this check reserved it, a repeat is a duplicate.
  expect(() => graph.checkSpawn(parent.id, brief)).toThrow();
}

beforeEach(() => {
  __resetCallGraphsForTests();
  resetCircuitBreakerRegistry();
  backupRow = null;
});

describe('spawnChild — lane visibility', () => {
  test('primaryModel mismatch names the lane and its bound model, and releases the fingerprint', async () => {
    const runs: RunOpts[] = [];
    const parent = makeNode();
    const p = params({ routePolicy: { primaryModel: 'gpt-5-turbo' } });
    const result = await makeSpawner(runs).spawnChild(parent, p as never, ctx() as never);
    expect(result.status).toBe('denied');
    expect(result.notes).toContain("Requested primaryModel 'gpt-5-turbo'");
    expect(result.notes).toContain("The 'build' lane is bound to 'gpt-x'");
    expect(runs).toHaveLength(0);
    fingerprintReleased(parent, p, result);
  });

  test('circuit open + backup bound ⇒ child starts on the backup, primary recorded as not started', async () => {
    for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure('openai');
    backupRow = rows['claude-y'];
    const runs: RunOpts[] = [];
    const result = await makeSpawner(runs).spawnChild(makeNode(), params() as never, ctx() as never);
    expect(result.status).toBe('ok');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ childModel: 'claude-y', childModelName: 'claude-y', route: 'backup', requestedModel: 'gpt-x' });
    expect(runs[0].attempts).toHaveLength(1);
    expect(runs[0].attempts[0]).toMatchObject({ status: 'not_started', route: 'primary', selectedModel: 'gpt-x' });
    expect(runs[0].attempts[0].error).toMatch(/^lane 'build' model gpt-x unavailable: circuit breaker for 'openai' open since/);
  });

  test('circuit open + no backup ⇒ denied with the reason, no child, fingerprint released', async () => {
    for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure('openai');
    const runs: RunOpts[] = [];
    const parent = makeNode();
    const p = params();
    const result = await makeSpawner(runs).spawnChild(parent, p as never, ctx() as never);
    expect(result.notes).toMatch(/lane 'build' model gpt-x unavailable: circuit breaker for 'openai' open since .*; no backup bound\. No child was started/);
    expect(runs).toHaveLength(0);
    fingerprintReleased(parent, p, result);
  });

  test('circuit open + routePolicy.allowBackup false ⇒ denied even with a backup bound', async () => {
    for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure('openai');
    backupRow = rows['claude-y'];
    const runs: RunOpts[] = [];
    const result = await makeSpawner(runs).spawnChild(makeNode(), params({ routePolicy: { allowBackup: false } }) as never, ctx() as never);
    expect(result.status).toBe('denied');
    expect(result.notes).toMatch(/backup disabled by routePolicy/);
    expect(runs).toHaveLength(0);
  });

  test('healthy lane ⇒ primary, no skipped attempt', async () => {
    backupRow = rows['claude-y'];
    const runs: RunOpts[] = [];
    await makeSpawner(runs).spawnChild(makeNode(), params() as never, ctx() as never);
    expect(runs[0]).toMatchObject({ childModel: 'gpt-x', attempts: [] });
    expect(runs[0].route).toBeUndefined();
  });
});
