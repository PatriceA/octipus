/**
 * Backups end to end (docs/BACKUP.md) on embedded PGlite: a real dump of
 * the database with its vault, a real tar of the workspace files, the check
 * that loads them back, retention, the daily gate, and what a failure does.
 *
 * What must hold: a backup counts only once it was loaded back and the
 * current master key decrypted its vault; a changed byte is caught; a dump
 * restored the way the CLI restores it opens as a database; old backups go
 * only after a good one; a failed backup tells the admins.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
const WORKSPACE = mkdtempSync(join(tmpdir(), 'octipus-backup-ws-'));
const BACKUPS = mkdtempSync(join(tmpdir(), 'octipus-backup-out-'));
process.env.WORKSPACE_PATH = WORKSPACE;
process.env.DOCUMENTS_PATH = join(WORKSPACE, 'documents');
process.env.BACKUP_PATH = BACKUPS;
process.env.BACKUP_KEEP = '2';
process.env.BACKUP_HOUR = '3';

const admin = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-backup-db-'));
  const { resetConfig } = await import('@/config');
  resetConfig();
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault, getVault } = await import('@/security/vault');
  await initializeVault();
  await getVault().setSystemSecret('backup-test-secret', 'the secret value', { description: 'x', tags: ['system'] });
  mkdirSync(join(WORKSPACE, 'documents'), { recursive: true });
  writeFileSync(join(WORKSPACE, 'documents', 'rechnung.pdf'), '%PDF-1.4 invoice');
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('a backup', () => {
  test('holds the database with its vault and the workspace files, and is checked before it counts', async () => {
    const { runBackup, listBackups } = await import('./service');
    const status = await runBackup('manual', new Date('2026-10-20T02:00:00Z'));
    expect(status).toMatchObject({ ok: true, id: '20261020T020000Z' });
    const [manifest] = await listBackups();
    expect(manifest.database.kind).toBe('pglite');
    expect(manifest.vault.rows).toBeGreaterThanOrEqual(1);
    expect(manifest.vault.keyChecked).toBe(true);
    expect(manifest.files?.map((f) => [f.file, f.root])).toEqual([['files-1.tar.gz', WORKSPACE]]);
    expect(manifest.verified).toMatchObject({ ok: true, problems: [] });
    // Nothing of the master key is in it.
    const dir = join(BACKUPS, manifest.id);
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name)).includes(Buffer.from(process.env.MASTER_KEY as string))).toBe(false);
    }
  });

  test('a changed byte is caught', async () => {
    const { listBackups, verifyBackup } = await import('./service');
    const [manifest] = await listBackups();
    const file = join(BACKUPS, manifest.id, 'files-1.tar.gz');
    const bytes = readFileSync(file);
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(file, bytes);
    const result = await verifyBackup(join(BACKUPS, manifest.id));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['files-1.tar.gz does not match its checksum']);
    // Recorded as a later check; the backup's first check still stands.
    const [after] = await listBackups();
    expect([after.verified?.ok, after.rechecked?.ok]).toEqual([true, false]);
  });

  test('the dump, restored the way the CLI restores it, opens as the database with its vault', async () => {
    const { runBackup, listBackups } = await import('./service');
    const { runCommand } = await import('@/utils/proc');
    const status = await runBackup('manual', new Date('2026-10-21T02:00:00Z'));
    expect(status.ok).toBe(true);
    const manifest = (await listBackups()).find((b) => b.id === status.id);
    const target = mkdtempSync(join(tmpdir(), 'octipus-restored-'));
    const r = await runCommand({ command: 'tar', args: ['-xzf', join(BACKUPS, status.id as string, manifest!.database.file), '-C', target] });
    expect(r.exitCode).toBe(0);
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const restored = await PGlite.create({ dataDir: target, extensions: { vector } });
    try {
      const { rows } = await restored.query<{ name: string; encrypted_value: string }>(`SELECT name, encrypted_value FROM vault WHERE name = 'backup-test-secret'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].encrypted_value).not.toContain('the secret value');
    } finally {
      await restored.close();
    }
  });

  test('keeps the newest good backups, removing older ones only after a good one', async () => {
    const { runBackup, listBackups } = await import('./service');
    const status = await runBackup('manual', new Date('2026-10-22T02:00:00Z'));
    expect(status.ok).toBe(true);
    // keep = 2: the two newest good backups stay; the tampered first one (no longer good) is older and goes.
    expect((await listBackups()).map((b) => b.id)).toEqual(['20261022T020000Z', '20261021T020000Z']);
  });

  test('one scheduled backup per daily slot: catching up after a missed slot, untouched by manual runs', async () => {
    const { maybeRunScheduledBackup, runBackup } = await import('./service');
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);
    // 01:00 on the 25th: the slot of the 24th (03:00) has no scheduled run yet (the server was down): catch up.
    expect((await maybeRunScheduledBackup(local(25, 1)))?.ok).toBe(true);
    // Later the same night: that slot is done.
    expect(await maybeRunScheduledBackup(local(25, 2, 30))).toBeNull();
    // A manual backup does not stand in for the next slot.
    expect((await runBackup('manual', local(25, 2, 45))).ok).toBe(true);
    expect((await maybeRunScheduledBackup(local(25, 3)))?.ok).toBe(true);
    expect(await maybeRunScheduledBackup(local(25, 3, 1))).toBeNull();
  });

  test('a failed backup is recorded and the admins are told', async () => {
    const { runBackup, lastRun, listBackups } = await import('./service');
    // A backup with this id is already there: the run fails, and leaves it alone.
    const [newest] = await listBackups();
    const at = new Date(newest.id.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const status = await runBackup('manual', at);
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/already exists/);
    expect((await lastRun())?.ok).toBe(false);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT type, title FROM notifications WHERE user_id = '${admin}'`);
    expect(rows).toEqual([{ type: 'backup_failed', title: 'Backup failed' }]);
  });
});
