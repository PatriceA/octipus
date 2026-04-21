/**
 * Integration test helpers — boot Postgres/Redis connections against the
 * docker-compose.test.yml containers. Opt-in via INTEGRATION=1.
 *
 * Usage:
 *   import { isIntegration, setupIntegrationDb, setupIntegrationStorage } from '@/test-helpers/integration';
 *
 *   describe.skipIf(!isIntegration)('… (Integration)', () => {
 *     beforeAll(async () => { await setupIntegrationDb(); });
 *     afterAll(async () => { await teardownIntegration(); });
 *   });
 */

import { resetConfig } from '@/config';
import { closeDb, initializeDb, initializeExtensions } from '@/db/postgres';
import { closeStorage, getStorageProvider, initializeStorage } from '@/db/storage';

export const isIntegration = process.env.INTEGRATION === '1';

let dbInitialized = false;
let storageInitialized = false;

/**
 * Initialize the database connection for integration tests.
 * Expects DATABASE_URL to point at a pre-migrated test database
 * (the test:integration runner handles migrations before tests).
 */
export async function setupIntegrationDb(): Promise<void> {
  if (dbInitialized) return;
  // Config is cached; reset so a fresh env read picks up the test DATABASE_URL
  resetConfig();
  process.env.STORAGE_MODE = 'external';
  await initializeDb();
  await initializeExtensions();
  dbInitialized = true;
}

/**
 * Initialize Redis-backed storage for integration tests.
 */
export function setupIntegrationStorage(): void {
  if (storageInitialized) return;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL must be set for integration tests');
  initializeStorage({
    mode: 'external',
    redis: {
      url,
      keyPrefix: `test:${Math.random().toString(36).slice(2, 8)}:`,
      maxRetries: 3,
      retryDelay: 100,
    },
  });
  storageInitialized = true;
}

/**
 * Tear down all integration connections.
 */
export async function teardownIntegration(): Promise<void> {
  if (storageInitialized) {
    try {
      // Flush the test keyspace so subsequent runs start clean
      const provider = getStorageProvider();
      // Best-effort — only the Redis provider has a flushable client
      const anyProvider = provider as unknown as { getRedisClient?: () => { flushdb: () => Promise<unknown> } };
      if (anyProvider.getRedisClient) {
        await anyProvider.getRedisClient().flushdb();
      }
    } catch { /* ignore */ }
    await closeStorage();
    storageInitialized = false;
  }
  if (dbInitialized) {
    await closeDb();
    dbInitialized = false;
  }
}

/**
 * Truncate the given tables — useful between tests to keep them isolated.
 * Uses raw SQL so we don't have to import every schema.
 */
export async function truncateTables(tables: string[]): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(', ');
  await executeRaw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
