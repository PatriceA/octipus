/**
 * Topic backup-model retry (Topics page "Backup" binding).
 *
 * `runChildWithRetry` must make ONE extra attempt on the topic's backup model
 * when the child ends in provider_error / tool_error, and must not touch the
 * backup lookup on success. No DB: `getModelRegistry` is module-mocked with a
 * stub backup lookup and the spawner's private `singleSpawnAndRun` is
 * instance-patched.
 */
import { describe, expect, test, vi } from 'vitest';

let backupModelId: string | null = null;

// Pin our own `getModelRegistry` stub whose backup lookup is driven by
// `backupModelId` (the only method this suite needs; the spawner's
// `singleSpawnAndRun` is instance-patched below). The mock is scoped to this
// file. No-op + skip under the integration runner.
const inIntegration = process.env.INTEGRATION === '1';

// Top level, because `vi.mock` is hoisted whatever it is nested inside — the
// old `if (!inIntegration)` wrapper read as a guard and was none: the stub was
// installed under the integration runner too. The condition belongs in the
// FACTORY, which runs where it is written, so the real module is returned when
// a real database is present. (Vitest 5 makes the nested form an error.)
vi.mock('@/models/model-registry', async (importOriginal) => {
  if (process.env.INTEGRATION === '1') return await importOriginal<object>();
  return {
    getModelRegistry: () => ({
      getBackupModelForTopic: async () => (backupModelId ? { modelId: backupModelId } : null),
      getModelForTopic: async () => null,
      getModelByModelId: async () => null,
      getDefaultModel: async () => null,
    }),
  };
});

const { SwarmSpawner } = await import('./spawner');
type ChildResult = import('./types').ChildResult;

type Budget = {
  tokens: { cap: number; used: number };
  wallClockMs: { cap: number; startedAt: number };
  fanOut: { cap: number; used: number };
  depth: number;
};
type RunOpts = {
  childRole: string;
  childLane: string;
  childModel: string;
  parent: { id: string };
  /** The backup resolves for the requester (personal bindings have none, so it is the install's). */
  parentContext: { userId: string };
  reason: string;
  budget: Budget;
  onWorkerStarted?: (agentId: string) => void;
};

function makeSpawner(resultsByAttempt: ChildResult['status'][], calls: RunOpts[]) {
  const spawner = new SwarmSpawner({} as never);
  let attempt = 0;
  (spawner as unknown as { singleSpawnAndRun: (opts: RunOpts, retry: boolean) => Promise<ChildResult> })
    .singleSpawnAndRun = async (opts) => {
      // Snapshot the fan-out counter as this attempt SAW it — the budget object
      // is shared and mutated in place, so a reference would read back whatever
      // the last attempt left behind.
      calls.push({ ...opts, budget: { ...opts.budget, fanOut: { ...opts.budget.fanOut } } });
      // Every attempt spends its whole fan-out allowance, as a real child that
      // got as far as spawning subagents would.
      opts.budget.fanOut.used = opts.budget.fanOut.cap;
      const status = resultsByAttempt[Math.min(attempt, resultsByAttempt.length - 1)];
      attempt++;
      return { nodeId: `n${attempt}`, kind: 'agent', status, output: '', usedTokens: 0, durationMs: 1, spawnedChildren: [] } as ChildResult;
    };
  return spawner as unknown as { runChildWithRetry: (opts: RunOpts) => Promise<ChildResult> };
}

const baseOpts = (): RunOpts => ({
  childRole: 'research',
  childLane: 'agents',
  childModel: 'primary-id',
  parent: { id: 'p1' },
  parentContext: { userId: 'system' },
  reason: 'normal',
  // A real budget, because the retry paths write to it. The fixture carried
  // none, so `runChildWithRetry` was being driven through a shape no caller can
  // produce — `budget` is required by its signature and every call site fills
  // it — and the suite could not see the fan-out reset at all.
  budget: {
    tokens: { cap: 80_000, used: 0 },
    wallClockMs: { cap: 600_000, startedAt: 0 },
    fanOut: { cap: 4, used: 0 },
    depth: 1,
  },
});

const suite = inIntegration ? describe.skip : describe;

suite('runChildWithRetry — topic backup model', () => {
  test('ok result ⇒ single attempt, no backup consultation', async () => {
    backupModelId = 'backup-id';
    const calls: RunOpts[] = [];
    const result = await makeSpawner(['ok'], calls).runChildWithRetry(baseOpts());
    expect(result.status).toBe('ok');
    expect(calls.length).toBe(1);
    expect(calls[0].childModel).toBe('primary-id');
  });

  test('provider_error + backup bound ⇒ one extra attempt on the backup model', async () => {
    backupModelId = 'backup-id';
    const calls: RunOpts[] = [];
    const result = await makeSpawner(['provider_error', 'ok'], calls).runChildWithRetry(baseOpts());
    expect(result.status).toBe('ok');
    expect(calls.length).toBe(2);
    expect(calls[1].childModel).toBe('backup-id');
    expect(calls[1].reason).toBe('retry');
    // A fresh node gets a fresh fan-out allowance. The budget spread shares the
    // `fanOut` OBJECT, and `handleSpawn` increments `used` on it, so the backup
    // attempt inherited a counter already at cap from the attempt that failed —
    // every `spawn_child` it made was denied with `concurrency_limit`.
    expect(calls[1].budget.fanOut).toEqual({ cap: 4, used: 0 });
  });

  test('provider_error + no backup bound ⇒ original result surfaces unchanged', async () => {
    backupModelId = null;
    const calls: RunOpts[] = [];
    const result = await makeSpawner(['provider_error'], calls).runChildWithRetry(baseOpts());
    expect(result.status).toBe('provider_error');
    expect(calls.length).toBe(1);
  });

  test('backup identical to failed model ⇒ not retried', async () => {
    backupModelId = 'primary-id';
    const calls: RunOpts[] = [];
    const result = await makeSpawner(['provider_error'], calls).runChildWithRetry(baseOpts());
    expect(result.status).toBe('provider_error');
    expect(calls.length).toBe(1);
  });

  test('tool_error ⇒ crash retry on new node first, then the backup attempt', async () => {
    backupModelId = 'backup-id';
    const calls: RunOpts[] = [];
    const result = await makeSpawner(['tool_error', 'tool_error', 'ok'], calls).runChildWithRetry(baseOpts());
    expect(result.status).toBe('ok');
    expect(calls.length).toBe(3);
    expect(calls[0].childModel).toBe('primary-id');
    expect(calls[1].childModel).toBe('primary-id'); // crash retry, same model, new node
    expect(calls[2].childModel).toBe('backup-id'); // backup attempt
    // Both retries are new nodes, so both start from a clean allowance.
    expect(calls[1].budget.fanOut).toEqual({ cap: 4, used: 0 });
    expect(calls[2].budget.fanOut).toEqual({ cap: 4, used: 0 });
  });

  test('every retry attempt reports its new worker, so steer_child follows the live one', async () => {
    backupModelId = 'backup-id';
    const calls: RunOpts[] = [];
    const onWorkerStarted = () => {};
    await makeSpawner(['tool_error', 'tool_error', 'ok'], calls).runChildWithRetry({ ...baseOpts(), onWorkerStarted });
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call.onWorkerStarted).toBe(onWorkerStarted);
  });
});
