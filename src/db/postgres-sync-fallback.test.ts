/**
 * `getDb()`'s synchronous fallback used `require` from an ES module, so it
 * threw ReferenceError instead of connecting. Callers that swallow a getDb()
 * failure then reported the symptom instead of the cause — the eval runner's
 * `--integration` mode died with "No enabled models configured in the
 * database" against an install with eighteen of them.
 */
import { describe, expect, test, vi } from 'vitest';

describe('getDb sync fallback', () => {
  test('connects instead of throwing ReferenceError when nothing initialized the DB', async () => {
    vi.resetModules();
    process.env.STORAGE_MODE = 'external';

    vi.doMock('@/config', () => ({
      getConfig: () => ({
        database: {
          url: 'postgres://user:pass@127.0.0.1:1/never-connected',
          poolSize: 1,
          idleTimeout: 1000,
          connectionTimeout: 1000,
        },
      }),
    }));

    const { getDb, closeDb } = await import('./postgres');
    // `postgres()` is lazy — building the client does not open a socket, so
    // this exercises the require path without needing a live server.
    const db = getDb();
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
    await closeDb().catch(() => { /* nothing was ever connected */ });
    vi.doUnmock('@/config');
    vi.resetModules();
  });
});
