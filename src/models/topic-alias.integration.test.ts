/**
 * Topic consolidation — end-to-end aliasing against a real (embedded PGlite)
 * DB: retired topic names ('coding', 'memory_extraction', …) must resolve the
 * canonical lane's binding in the model registry AND land on the lane's row in
 * topics_config; the experts.topic column must default to 'agents'.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
process.env.STORAGE_MODE = 'embedded';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-topic-alias-'));
process.env.DATA_DIR = DATA_DIR;

import { getDb } from '@/db/postgres';
import { experts } from '@/db/schema/experts';
import { getModelRegistry } from '@/models/model-registry';
import { getTopicConfig, loadTopicConfigs, setTopicConfig } from '@/models/topic-config';

beforeAll(async () => {
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const registry = getModelRegistry();
  await registry.registerModel({
    name: 'lane-primary', provider: 'ollama', modelId: 'lane-primary-id', isEnabled: true,
    topicRoles: { agents: 'primary', background: 'primary' },
  } as never);
  await registry.registerModel({
    name: 'lane-backup', provider: 'ollama', modelId: 'lane-backup-id', isEnabled: true,
    topicRoles: { agents: 'backup' },
  } as never);
});

afterAll(async () => {
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch (err) {
    console.debug('topic-alias teardown: closeDb failed', err);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('model registry aliasing', () => {
  test("retired role topic 'coding' resolves the agents-lane primary", async () => {
    const m = await getModelRegistry().getModelForTopic('coding');
    expect(m?.modelId).toBe('lane-primary-id');
  });

  test("retired background topic 'memory_extraction' resolves the background-lane primary", async () => {
    const m = await getModelRegistry().getModelForTopic('memory_extraction');
    expect(m?.modelId).toBe('lane-primary-id');
  });

  test("retired role topic 'review' resolves the agents-lane backup", async () => {
    const m = await getModelRegistry().getBackupModelForTopic('review');
    expect(m?.modelId).toBe('lane-backup-id');
  });

  test("long-form role topic 'research' now resolves the writing lane (unbound here)", async () => {
    // research → writing (not agents); this fixture binds no writing model, so
    // it fails loud — proving the re-route, not the agents fallback.
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
    expect(getTopicConfig('agents').temperature).toBe(0.3);
    // The persisted row is keyed canonically.
    await loadTopicConfigs();
    expect(getTopicConfig('agents').executorModel).toBe('lane-primary');
  });
});

describe('experts.topic column', () => {
  test("defaults to the 'agents' lane", async () => {
    const db = getDb();
    const [row] = await db.insert(experts).values({
      name: `lane-default-${rand(4)}`, role: 'coding', isSystem: false,
    }).returning({ topic: experts.topic });
    expect(row.topic).toBe('agents');
  });
});
