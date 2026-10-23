/**
 * Modules on the database (docs/MODULES.md): a new install starts with the
 * core only, an install from before modules with every module on, and a
 * change goes through the settings row.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-modules-'));
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  const { closeStorage } = await import('@/db/storage');
  await closeDb();
  await closeStorage();
});

async function storedRow(): Promise<string | null> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT value FROM settings WHERE key = 'modules.enabled'`);
  return (rows[0] as { value: string } | undefined)?.value ?? null;
}

describe('the modules migration', () => {
  const sql = readFileSync(join(__dirname, '../../db/migrations/0151_modules.sql'), 'utf8');

  test('a new install (no users when it ran) has no row: the core only', async () => {
    expect(await storedRow()).toBeNull();
  });

  test('an install with users gets every module on, and a second run changes nothing', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`INSERT INTO users (username) VALUES ('existing')`);
    await executeRaw(sql);
    const value = JSON.parse((await storedRow()) ?? '[]') as string[];
    const { MODULES } = await import('@/modules');
    for (const m of MODULES) expect(value).toContain(m.id);
    await executeRaw(`UPDATE settings SET value = '["mail"]' WHERE key = 'modules.enabled'`);
    await executeRaw(sql);
    expect(await storedRow()).toBe('["mail"]');
  });

  test('a change is stored in the setting, with what it depends on', async () => {
    const { setModuleOn, setEnabledModules } = await import('./registry');
    expect(await setModuleOn('business', true)).toEqual(['business', 'mail']);
    expect(JSON.parse((await storedRow()) ?? '[]')).toEqual(['business', 'mail']);
    expect(await setModuleOn('mail', false)).toEqual(['business']);
    expect(await setEnabledModules([])).toEqual([]);
    expect(await storedRow()).toBe('[]');
  });
});
