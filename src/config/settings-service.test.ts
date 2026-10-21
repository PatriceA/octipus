/**
 * SettingsService reads for keys that are stored nowhere — on embedded PGlite
 * with the in-memory storage provider.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-settings-'));
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

describe('SettingsService.get for a key stored nowhere', () => {
  test('remembers the miss for the cache TTL; a write through the service ends it at once', async () => {
    const { SettingsService } = await import('./settings-service');
    const { executeRaw } = await import('@/db/postgres');
    const service = new SettingsService();
    await service.warmCache();

    expect(await service.get('plugin.unregistered')).toBeNull();
    // Written behind the service's back: not looked up again inside the window...
    await executeRaw(`INSERT INTO settings (key, value, value_type, category) VALUES ('plugin.unregistered', 'behind', 'string', 'general')`);
    expect(await service.get('plugin.unregistered')).toBeNull();
    // ...and read once it has passed.
    const later = Date.now() + 61_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await service.get('plugin.unregistered')).toBe('behind');
    } finally {
      clock.mockRestore();
    }

    expect(await service.get('plugin.other')).toBeNull();
    await service.set('plugin.other', 'via service');
    expect(await service.get('plugin.other')).toBe('via service');
  });
});

test('fresh reads and atomic transforms preserve direct database changes, and failed transforms roll back', async () => {
  const { SettingsService } = await import('./settings-service');
  const { executeRaw } = await import('@/db/postgres');
  const service = new SettingsService();
  await service.set('mcp.servers', [{ id: 'a', name: 'A', command: 'old', isEnabled: true }]);
  await executeRaw(`UPDATE settings SET value = '[{"id":"a","name":"A","command":"external","isEnabled":true}]' WHERE key = 'mcp.servers'`);
  expect((await service.getFresh('mcp.servers') as { command: string }[])[0].command).toBe('external');
  await executeRaw(`UPDATE settings SET value = '[{"id":"a","name":"A","command":"newer","isEnabled":true}]' WHERE key = 'mcp.servers'`);
  const updated = await service.update('mcp.servers', value => (value as Record<string, unknown>[]).map(server => ({ ...server, isEnabled: false })));
  expect(updated).toEqual([{ id: 'a', name: 'A', command: 'newer', isEnabled: false }]);
  await expect(service.update('mcp.servers', () => { throw new Error('conflict'); })).rejects.toThrow('conflict');
  expect(await service.getFresh('mcp.servers')).toEqual(updated);
});
