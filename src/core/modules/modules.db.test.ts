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
    expect(value).toEqual(['business', 'mail', 'scan-folders', 'protection']);
    await executeRaw(`UPDATE settings SET value = '["mail"]' WHERE key = 'modules.enabled'`);
    await executeRaw(sql);
    expect(await storedRow()).toBe('["mail"]');
  });

  test('0152: research, the reader and recall stay on where users existed, once', async () => {
    const { executeRaw } = await import('@/db/postgres');
    const later = readFileSync(join(__dirname, '../../db/migrations/0152_modules_research_reader_recall.sql'), 'utf8');
    await executeRaw(`UPDATE settings SET value = '["business","mail"]' WHERE key = 'modules.enabled'`);
    await executeRaw(later);
    await executeRaw(later);
    expect(JSON.parse((await storedRow()) ?? '[]').sort()).toEqual(['business', 'mail', 'reader', 'recall', 'research']);
    // Users but no row (an install that never switched a module): only the newly declared ones.
    await executeRaw(`DELETE FROM settings WHERE key = 'modules.enabled'`);
    await executeRaw(later);
    expect(JSON.parse((await storedRow()) ?? '[]')).toEqual(['research', 'reader', 'recall']);
    await executeRaw(`UPDATE settings SET value = '["business","mail"]' WHERE key = 'modules.enabled'`);
    // 0153, the same way: the inbox and artifacts.
    await executeRaw(readFileSync(join(__dirname, '../../db/migrations/0153_modules_inbox_artifacts.sql'), 'utf8'));
    expect(JSON.parse((await storedRow()) ?? '[]').sort()).toEqual(['artifacts', 'business', 'inbox', 'mail']);
    await executeRaw(readFileSync(join(__dirname, '../../db/migrations/0154_modules_people_voice_channels.sql'), 'utf8'));
    expect(JSON.parse((await storedRow()) ?? '[]').sort()).toEqual(['artifacts', 'business', 'channels', 'inbox', 'mail', 'people', 'voice']);
    await executeRaw(`UPDATE settings SET value = '["business","mail"]' WHERE key = 'modules.enabled'`);
  });

  test('a change is stored in the setting, with what it depends on', async () => {
    const { setModuleOn, setEnabledModules } = await import('./registry');
    await (await import('@/db/postgres')).executeRaw(`UPDATE settings SET value = '["mail"]' WHERE key = 'modules.enabled'`);
    expect(await setModuleOn('business', true)).toEqual(['business', 'mail']);
    expect(JSON.parse((await storedRow()) ?? '[]')).toEqual(['business', 'mail']);
    expect(await setModuleOn('mail', false)).toEqual(['business']);
    expect(await setEnabledModules([])).toEqual([]);
    expect(await storedRow()).toBe('[]');
  });
});
