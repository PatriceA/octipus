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
import { closeDb, initializeDb, initializeExtensions, isDbInitialized } from '@/db/postgres';
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
  // Self-healing: if a prior test file called closeDb() directly (instead of
  // teardownIntegration), the real connection is gone even though our
  // module-global `dbInitialized` is still true. Re-init whenever the live
  // connection is missing so later files don't throw "Database not initialized".
  if (dbInitialized && isDbInitialized()) return;
  dbInitialized = false;
  // Config is cached; reset so a fresh env read picks up the test DATABASE_URL
  resetConfig();
  process.env.STORAGE_MODE = 'external';
  await initializeDb();
  await initializeExtensions();
  dbInitialized = true;
}

/**
 * Initialize external storage for integration tests.
 *
 * The database comes first and is set up here rather than left to the caller,
 * because external storage now runs ON the database: a suite that asked for
 * storage alone used to get a working Valkey connection and now gets
 * "Database not initialized" on its first cache read. Ordering that the
 * runtime requires belongs in the helper, not in each caller's `beforeAll`.
 */
export async function setupIntegrationStorage(): Promise<void> {
  await setupIntegrationDb();
  if (storageInitialized) return;
  initializeStorage({ mode: 'external' });
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
