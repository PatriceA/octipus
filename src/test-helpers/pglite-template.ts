/**
 * One migrated embedded database per Vitest invocation, copied into every
 * suite's fresh DATA_DIR by `initEmbedded` (src/db/postgres.ts) instead of
 * each of the ~200 database suites running initdb and every migration itself.
 * Measured: fresh boot ~1.0s + migrations ~0.8s per suite vs ~0.1s for
 * copy + boot, and the database project runs one file at a time.
 *
 * Built from the live migrations on every run, so it can never go stale.
 * Suites still call runMigrations(); against the copy it is a no-op.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgliteTemplate: string;
  }
}

export default async function setup(project: Pick<TestProject, 'provide' | 'getProvidedContext'>): Promise<() => void> {
  const parent = project.getProvidedContext().testTmpRoot;
  if (!parent) throw new Error('Test scratch root must be initialized before the PGlite template');
  const dir = mkdtempSync(join(parent, 'pglite-template-'));
  const saved = { ...process.env };
  const rand = () => randomBytes(24).toString('hex');
  try {
    // Only what config loading needs to open an embedded database; restored below.
    Object.assign(process.env, { STORAGE_MODE: 'embedded', DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'test' });
    process.env.MASTER_KEY ??= `test-master-${rand()}`;
    process.env.JWT_SECRET ??= `test-jwt-${rand()}`;
    process.env.SESSION_SECRET ??= `test-session-${rand()}`;
    const { initializeDb, closeDb } = await import('@/db/postgres');
    const { runMigrations } = await import('@/db/migrate');
    await initializeDb();
    try { await runMigrations(); } finally { await closeDb(); }
    project.provide('pgliteTemplate', dir);
  } catch (error) {
    // Fatal: the database project runs two workers, which is only safe because
    // no suite runs initdb itself (vitest.config.ts). A template that will not
    // build means the migrations are broken anyway.
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`[test setup] PGlite template build failed: ${error instanceof Error ? error.message : error}`, { cause: error });
  } finally {
    // In place: replacing process.env detaches it from the real environment.
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return () => rmSync(dir, { recursive: true, force: true });
}
