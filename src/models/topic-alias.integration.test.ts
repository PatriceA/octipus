/**
 * Topic consolidation — end-to-end aliasing against a real (embedded PGlite)
 * DB: retired topic names ('coding', 'memory_extraction', …) must resolve the
 * canonical lane's binding in the model registry AND land on the lane's row in
 * topics_config.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIntegration } from '@/test-helpers/integration';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

import { getDb } from '@/db/postgres';
import { getModelRegistry } from '@/models/model-registry';
import { getTopicConfig, loadTopicConfigs, setTopicConfig } from '@/models/topic-config';

// Gated behind INTEGRATION=1 like every other `.integration.test.ts`. This
// setup runs a real embedded-PGlite `initializeDb()` + full migration and
// registers models on the *process-global* DB and model-registry singletons.
// In the shared unit run those singletons are initialized by whichever test
// file happens to run first, so the outcome is order-dependent — and because
// file order differs between local and CI, this file-scope hook was the lone
// `(unnamed)` failure that kept CI red (passing locally, failing in CI). The
// prior 30s hook-timeout bump treated the symptom, not the cause. Run it
// isolated via `npm run test:integration`.
describe.skipIf(!isIntegration)('Topic consolidation (Integration)', () => {
  let dataDir: string;

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    dataDir = mkdtempSync(join(tmpdir(), 'octipus-topic-alias-'));
    process.env.DATA_DIR = dataDir;

    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();

    // `agents` was the single worker lane these bindings used to sit on. It is
    // split into `build` and `everyday`, with `verify` taking review and QA —
    // so a retired name no longer resolves to ONE lane, and binding the old
    // name here would test a lane nothing routes to.
    const registry = getModelRegistry();
    await registry.registerModel({
      name: 'lane-primary', provider: 'ollama', modelId: 'lane-primary-id', isEnabled: true,
      topicRoles: { build: 'primary', background: 'primary' },
    } as never);
    await registry.registerModel({
      name: 'lane-backup', provider: 'ollama', modelId: 'lane-backup-id', isEnabled: true,
      topicRoles: { build: 'backup', verify: 'backup' },
    } as never);
  }, 30_000); // initializeDb + full migration run can exceed the default hook
              // timeout under a loaded CI runner.

  afterAll(async () => {
    try {
      const { closeDb } = await import('@/db/postgres');
      await closeDb();
    } catch (err) {
      console.debug('topic-alias teardown: closeDb failed', err);
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  describe('model registry aliasing', () => {
    test("retired role topic 'coding' resolves the build-lane primary", async () => {
      const m = await getModelRegistry().getModelForTopic('coding');
      expect(m?.modelId).toBe('lane-primary-id');
    });

    test("retired background topic 'memory_extraction' resolves the background-lane primary", async () => {
      const m = await getModelRegistry().getModelForTopic('memory_extraction');
      expect(m?.modelId).toBe('lane-primary-id');
    });

    test("retired role topic 'review' resolves the VERIFY lane, not build", async () => {
      // The point of the verify lane is that review and QA can run on a
      // different model from the one that wrote the code. An alias that sent
      // `review` to `build` would quietly undo that.
      expect((await getModelRegistry().getBackupModelForTopic('review'))?.modelId).toBe('lane-backup-id');
      expect(await getModelRegistry().getModelForTopic('review')).toBeNull();
      expect(await getModelRegistry().getModelForTopic('qa')).toBeNull();
    });

    test("'research' resolves its OWN lane, not writing and not agents", async () => {
      // The alias to `writing` made a model bound to `research` unreachable —
      // the highest-token role in the system could not be pinned to a cheap or
      // local model. This fixture binds neither research nor writing, so a
      // null here proves it resolves research (fail loud), not a worker lane.
      const m = await getModelRegistry().getModelForTopic('research');
      expect(m).toBeNull();
    });

    test('an unknown topic still fails to resolve (fail loud preserved)', async () => {
      const m = await getModelRegistry().getModelForTopic('no-such-lane');
      expect(m).toBeNull();
    });
  });

  describe('topics_config aliasing', () => {
    test('writing a retired topic lands on the canonical lane row', async () => {
      await setTopicConfig('coding', { executorModel: 'lane-primary', temperature: 0.3, maxTokens: null });
      // Reads via the retired name AND the lane both hit the same row.
      expect(getTopicConfig('coding').temperature).toBe(0.3);
      expect(getTopicConfig('build').temperature).toBe(0.3);
      // The persisted row is keyed canonically.
      await loadTopicConfigs();
      expect(getTopicConfig('build').executorModel).toBe('lane-primary');
    });
  });

});
