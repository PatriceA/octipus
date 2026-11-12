/**
 * `spawnChild` up to the hand-off to `runChildWithRetry`: the routePolicy
 * mismatch denial and the pre-spawn availability check (lane-availability.ts),
 * which runs inside `resolveChildModel` so a child moved to the backup gets the
 * backup's tier and prompt.
 *
 * No DB: the session read, skills, the model registry, `resolveModel` and the
 * vault redaction are module-mocked; `runChildWithRetry` is instance-patched,
 * so what is asserted is what it is handed.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Row = { modelId: string; name: string; provider: string; isEnabled?: boolean };
const rows: Record<string, Row> = {
  'gpt-x': { modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' },
  // Small by its id (3B), so the tier decision is visible on the hand-off.
  'qwen2.5:3b': { modelId: 'qwen2.5:3b', name: 'qwen2.5:3b', provider: 'ollama' },
  'exec-x': { modelId: 'exec-x', name: 'exec-x', provider: 'openai' },
};
let backupRow: Row | null = null;
let executorModel: string | null = null;

vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => null } }));
vi.mock('./spawn-cache', () => ({ lookupCacheHit: async () => null }));
vi.mock('@/skills/registry', () => ({ getSkillRegistry: () => ({ getByIds: async () => [], buildPromptSummary: async () => '' }) }));
vi.mock('@/skills/discovery', () => ({ discoverSkillIds: async () => [] }));
vi.mock('@/security/credential-redaction', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  redactAgentDiagnostics: async (_u: string, _w: string | null, data: unknown) => data,
}));
vi.mock('@/models/topic-config', async (importOriginal) => {
  const real = await importOriginal<{ getTopicConfig: (t: string) => object }>();
  return { ...real, getTopicConfig: (t: string) => ({ ...real.getTopicConfig(t), executorModel }) };
});
vi.mock('@/models/model-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModelRegistry: () => ({
    getModel: async (name: string) => rows[name] ?? null,
    getModelByModelId: async () => null,
  }),
}));
vi.mock('@/models/resolve-model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModel: async (req: { backup?: boolean; topic?: string; name?: string }) =>
    req.name ? rows[req.name] ?? null : req.backup ? backupRow : rows['gpt-x'],
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

type RunOpts = { childModel: string; childModelName: string; route?: string; requestedModel: string; childIsSmall?: boolean; attempts: DelegationAttempt[] };

function makeSpawner(runs: RunOpts[]) {
  const spawner = new SwarmSpawner({ publishEvent: () => {} } as never);
  (spawner as unknown as Record<string, unknown>).runChildWithRetry = async (opts: RunOpts) => {
    runs.push(opts);
    return { nodeId: 'child-1', kind: 'agent', status: 'ok', output: 'done', usedTokens: 0, durationMs: 1, spawnedChildren: [] };
  };
  return spawner;
}

const params = (over: Record<string, unknown> = {}) => ({
  role: 'coding', topic: 'build', subtopic: 'fix', taskBrief: 'fix the parser bug', expectedOutput: { shape: 'summary' as const }, ...over,
});

const openBreaker = (key: string) => { for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure(key); };

/** The brief's fingerprint was released: a second identical spawn is not a duplicate. */
function fingerprintReleased(parent: AgentNode, p: ReturnType<typeof params>, result: { status: string }): void {
  expect(result.status).toBe('denied');
  const graph = getCallGraph(parent.rootSessionId);
  const brief = {
    originalUserRequest: p.taskBrief, topicPath: 'root / build / fix', parentSummary: '', ancestry: [],
    taskBrief: p.taskBrief, constraints: [], inputArtifacts: [],
    expectedOutput: { shape: 'summary' as const, schema: undefined, maxTokens: 2000 }, forbidden: [], plan: undefined,
    ...((p as { fork?: boolean }).fork ? { fork: true } : {}),
  };
  expect(() => graph.checkSpawn(parent.id, brief)).not.toThrow();
  // …and it is the same brief: now that this check reserved it, a repeat is a duplicate.
  expect(() => graph.checkSpawn(parent.id, brief)).toThrow();
}

beforeEach(() => {
  __resetCallGraphsForTests();
  resetCircuitBreakerRegistry();
  backupRow = null;
  executorModel = null;
});

describe('spawnChild — lane visibility', () => {
  test('primaryModel mismatch names the lane and its bound model, and releases the fingerprint', async () => {
    const runs: RunOpts[] = [];
    const parent = makeNode();
    const p = params({ routePolicy: { primaryModel: 'gpt-5-turbo' } });
    const result = await makeSpawner(runs).spawnChild(parent, p as never, ctx() as never);
    expect(result.notes).toContain("Requested primaryModel 'gpt-5-turbo'");
    expect(result.notes).toContain("The 'build' lane is bound to 'gpt-x'");
    expect(runs).toHaveLength(0);
    fingerprintReleased(parent, p, result);
  });

  test('a planned child: the mismatch names the executor as the executor, with the primary', async () => {
    executorModel = 'exec-x';
    const runs: RunOpts[] = [];
    const p = params({ routePolicy: { primaryModel: 'gpt-5-turbo' }, plan: [{ step: 'edit the parser' }] });
    const result = await makeSpawner(runs).spawnChild(makeNode(), p as never, ctx() as never);
    expect(result.status).toBe('denied');
    expect(result.notes).toContain("Planned children of the 'build' lane run on its executor 'exec-x' (primary 'gpt-x')");
  });

  test('the routed primary still passes a primaryModel check after a backup substitution', async () => {
    openBreaker('openai');
    backupRow = rows['qwen2.5:3b'];
    const runs: RunOpts[] = [];
    const result = await makeSpawner(runs).spawnChild(makeNode(), params({ routePolicy: { primaryModel: 'gpt-x' } }) as never, ctx() as never);
    expect(result.status).toBe('ok');
    expect(runs[0].childModel).toBe('qwen2.5:3b');
  });

  test('circuit open + backup bound ⇒ child starts on the backup, with the backup\'s tier, primary recorded as not started', async () => {
    openBreaker('openai');
    backupRow = rows['qwen2.5:3b'];
    const runs: RunOpts[] = [];
    const result = await makeSpawner(runs).spawnChild(makeNode(), params() as never, ctx() as never);
    expect(result.status).toBe('ok');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ childModel: 'qwen2.5:3b', childModelName: 'qwen2.5:3b', route: 'backup', requestedModel: 'gpt-x', childIsSmall: true });
    expect(runs[0].attempts).toHaveLength(1);
    expect(runs[0].attempts[0]).toMatchObject({ status: 'not_started', route: 'primary', selectedModel: 'gpt-x' });
    expect(runs[0].attempts[0].error).toMatch(/^lane 'build' model gpt-x unavailable: circuit breaker for 'openai' open since/);
  });

  test('circuit open + no backup ⇒ denied with the reason, no child, fingerprint released', async () => {
    openBreaker('openai');
    const runs: RunOpts[] = [];
    const parent = makeNode();
    const p = params();
    const result = await makeSpawner(runs).spawnChild(parent, p as never, ctx() as never);
    expect(result.notes).toMatch(/lane 'build' model gpt-x unavailable: circuit breaker for 'openai' open since .*; no backup bound\. No child was started/);
    expect(runs).toHaveLength(0);
    fingerprintReleased(parent, p, result);
  });

  test('a fork that cannot fork becomes an ordinary child — and is checked like one', async () => {
    openBreaker('openai');
    const runs: RunOpts[] = [];
    const parent = makeNode();
    const p = params({ fork: true });
    const result = await makeSpawner(runs).spawnChild(parent, p as never, ctx() as never);
    expect(result.notes).toMatch(/no backup bound/);
    expect(runs).toHaveLength(0);
    fingerprintReleased(parent, p, result);
  });

  test('circuit open + routePolicy.allowBackup false ⇒ denied even with a backup bound', async () => {
    openBreaker('openai');
    backupRow = rows['qwen2.5:3b'];
    const runs: RunOpts[] = [];
    const result = await makeSpawner(runs).spawnChild(makeNode(), params({ routePolicy: { allowBackup: false } }) as never, ctx() as never);
    expect(result.status).toBe('denied');
    expect(result.notes).toMatch(/backup disabled by routePolicy/);
    expect(runs).toHaveLength(0);
  });

  test('healthy lane ⇒ primary, no skipped attempt', async () => {
    backupRow = rows['qwen2.5:3b'];
    const runs: RunOpts[] = [];
    await makeSpawner(runs).spawnChild(makeNode(), params() as never, ctx() as never);
    expect(runs[0]).toMatchObject({ childModel: 'gpt-x', requestedModel: 'gpt-x', childIsSmall: false, attempts: [] });
    expect(runs[0].route).toBeUndefined();
  });
});
