/**
 * Topic backup-model retry (Topics page "Backup" binding).
 *
 * `runChildWithRetry` must make ONE extra attempt on the topic's backup model
 * when the child ends in provider_error / tool_error, and must not touch the
 * backup lookup on success. No DB: the registry singleton's
 * `getBackupModelForTopic` and the spawner's private `singleSpawnAndRun` are
 * instance-patched (not module-mocked, so other test files stay unaffected).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getModelRegistry } from '@/models/model-registry';
import { SwarmSpawner } from './spawner';
import type { ChildResult } from './types';

type RunOpts = { childRole: string; childModel: string; parent: { id: string }; reason: string };

const registry = getModelRegistry();
const originalGetBackup = registry.getBackupModelForTopic.bind(registry);
let backupModelId: string | null = null;

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

const baseOpts = (): RunOpts => ({ childRole: 'research', childModel: 'primary-id', parent: { id: 'p1' }, reason: 'normal' });

beforeAll(() => {
  registry.getBackupModelForTopic = (async (_topic: string) =>
    backupModelId ? ({ modelId: backupModelId } as never) : null) as typeof registry.getBackupModelForTopic;
});

afterAll(() => {
  registry.getBackupModelForTopic = originalGetBackup;
});

describe('runChildWithRetry — topic backup model', () => {
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
