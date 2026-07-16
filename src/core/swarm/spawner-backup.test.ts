/**
 * Topic backup-model retry (Topics page "Backup" binding).
 *
 * `runChildWithRetry` must make ONE extra attempt on the topic's backup model
 * when the child ends in provider_error / tool_error, and must not touch the
 * backup lookup on success. No DB: `getModelRegistry` is module-mocked with a
 * stub backup lookup and the spawner's private `singleSpawnAndRun` is
 * instance-patched.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as realModelRegistry from '@/models/model-registry';

let backupModelId: string | null = null;

// bun's `mock.module` is process-global. Sibling unit suites (evaluators,
// litellm-client) replace `getModelRegistry` with a partial stub that omits
// `getBackupModelForTopic`, so grabbing the real singleton here is order-
// dependent and crashes when their mock leaks in first. Pin our own stub whose
// backup lookup is driven by `backupModelId` (the only method this suite needs;
// the spawner's `singleSpawnAndRun` is instance-patched below). The other
// getters mirror the sibling stubs so this superset can only be safer if it
// leaks forward. No-op + skip under the integration runner, whose real-DB
// suites would break if this partial mock leaked into them.
const inIntegration = process.env.INTEGRATION === '1';
if (!inIntegration) {
  mock.module('@/models/model-registry', () => ({
    getModelRegistry: () => ({
      getBackupModelForTopic: async () => (backupModelId ? { modelId: backupModelId } : null),
      getModelForTopic: async () => null,
      getModelByModelId: async () => null,
      getDefaultModel: async () => null,
    }),
  }));
  // Restore the real module after this suite — bun's mock.module is
  // process-global, so without this the partial stub leaks into later suites
  // (e.g. memory.extractor, which then sees a getModelRegistry() missing the
  // methods it needs). This mirrors openai-compat.test.ts.
  afterAll(() => {
    mock.module('@/models/model-registry', () => realModelRegistry);
  });
}

const { SwarmSpawner } = await import('./spawner');
type ChildResult = import('./types').ChildResult;

type RunOpts = { childRole: string; childLane: string; childModel: string; parent: { id: string }; reason: string };

function makeSpawner(resultsByAttempt: ChildResult['status'][], calls: RunOpts[]) {
  const spawner = new SwarmSpawner({} as never);
  let attempt = 0;
  (spawner as unknown as { singleSpawnAndRun: (opts: RunOpts, retry: boolean) => Promise<ChildResult> })
    .singleSpawnAndRun = async (opts) => {
      calls.push({ ...opts });
      const status = resultsByAttempt[Math.min(attempt, resultsByAttempt.length - 1)];
      attempt++;
      return { nodeId: `n${attempt}`, kind: 'agent', status, output: '', usedTokens: 0, durationMs: 1, spawnedChildren: [] } as ChildResult;
    };
  return spawner as unknown as { runChildWithRetry: (opts: RunOpts) => Promise<ChildResult> };
}

const baseOpts = (): RunOpts => ({ childRole: 'research', childLane: 'agents', childModel: 'primary-id', parent: { id: 'p1' }, reason: 'normal' });

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
  });
});
