#!/usr/bin/env tsx
/**
 * Octipus backups from the command line (docs/BACKUP.md). The same backup the
 * server writes every day: the database (with the encrypted vault) and the
 * workspace files, checked by loading them back.
 *
 *   npm run backup                       write and check a backup now
 *   npm run backup -- list               the backups in backup.path
 *   npm run backup -- verify <id|dir>    check a backup again
 *   npm run backup -- restore <id|dir> [--database] [--files] [--to <dir>] [--force]
 *
 * Restore with the server stopped. It never writes over data that is there:
 * the embedded database directory, and each files root, must be empty or
 * missing (move them aside first), or the files go into an empty `--to <dir>`.
 * An external database is replaced only with `--force`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function isEmptyOrMissing(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

async function backupDir(arg: string | undefined): Promise<string> {
  if (!arg) throw new Error('Name a backup: its id (from `list`) or its directory');
  const { backupRoot } = await import('@/core/backup/service');
  const dir = isAbsolute(arg) || arg.includes('/') ? resolve(arg) : join(backupRoot(), arg);
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`No backup at ${dir}`);
  return dir;
}

/** A restored directory readable by the Octipus user only, like the backup it came from. */
async function lockDown(dir: string): Promise<void> {
  const { runCommand } = await import('@/utils/proc');
  await runCommand({ command: 'chmod', args: ['-R', 'go-rwx', dir] }).catch(() => undefined);
}

async function restore(dir: string, args: string[]): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { getConfig } = await import('@/config');
  const { runCommand } = await import('@/utils/proc');
  const { verifyBackup, pgConnection, MANIFEST } = await import('@/core/backup/service');
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
  const wantDb = args.includes('--database') || !args.includes('--files');
  const wantFiles = args.includes('--files') || !args.includes('--database');
  const force = args.includes('--force');
  const toIdx = args.indexOf('--to');
  const toArg = toIdx >= 0 ? args[toIdx + 1] : undefined;
  if (toIdx >= 0 && (!toArg || toArg.startsWith('--'))) throw new Error('--to needs a directory');
  const to = toArg ? resolve(toArg) : null;

  // The roots come from the backup's manifest: absolute paths only, nothing tar could read as an option.
  const parts = (manifest.files ?? []) as Array<{ file: string; root: string }>;
  for (const part of parts) {
    if (!isAbsolute(part.root) || !/^files-\d+\.tar\.gz$/.test(part.file)) throw new Error(`The manifest names an unexpected files archive: ${part.file}`);
  }

  console.log(`Checking ${manifest.id} before restoring…`);
  const check = await verifyBackup(dir);
  if (!check.ok) throw new Error(`The backup did not pass its check: ${check.problems.join('; ')}`);

  if (wantDb) {
    if (manifest.database.kind === 'pglite') {
      const target = resolve(expandHome(process.env.DATA_DIR || getConfig().database.dataDir));
      if (!isEmptyOrMissing(target)) throw new Error(`The database directory ${target} is not empty. Stop the server and move it aside first.`);
      await mkdir(target, { recursive: true, mode: 0o700 });
      const r = await runCommand({ command: 'tar', args: ['-xzf', join(dir, manifest.database.file), '-C', target] });
      if (r.exitCode !== 0) throw new Error(`tar failed: ${r.stderr.trim()}`);
      await lockDown(target);
      console.log(`Database restored into ${target}`);
    } else {
      // pg_restore --clean drops what is there: never without saying so.
      if (!force) throw new Error('Restoring into DATABASE_URL replaces the tables there. Stop the server and run again with --force.');
      const { args: conn, env } = pgConnection();
      const r = await runCommand({ command: 'pg_restore', args: ['--clean', '--if-exists', '--no-owner', ...conn, join(dir, manifest.database.file)], env });
      if (r.exitCode !== 0) throw new Error(`pg_restore failed: ${r.stderr.trim().slice(0, 500)}`);
      console.log('Database restored');
    }
  }

  if (wantFiles && parts.length > 0) {
    const targets = parts.map((part, i) => ({ part, target: to ? join(to, `${i + 1}-${basename(part.root)}`) : part.root }));
    for (const { target } of targets) {
      if (!isEmptyOrMissing(target)) throw new Error(`${target} is not empty. Move it aside, or restore the files into an empty directory with --to <dir>.`);
    }
    for (const { part, target } of targets) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      const r = await runCommand({ command: 'tar', args: ['-xzf', join(dir, part.file), '-C', target] });
      if (r.exitCode !== 0) throw new Error(`tar failed: ${r.stderr.trim()}`);
      await lockDown(target);
      console.log(`Files restored into ${target}`);
    }
  }
  console.log('The vault needs the same master key (MASTER_KEY) the backup was written with.');
}

async function main(): Promise<void> {
  const [command = 'backup', ...rest] = process.argv.slice(2);
  const service = await import('@/core/backup/service');
  if (command === 'backup' || command.startsWith('--')) {
    const { initializeDb, closeDb } = await import('@/db/postgres');
    const { initializeVault } = await import('@/security/vault');
    await initializeDb();
    await initializeVault();
    try {
      const status = await service.runBackup('manual');
      if (!status.ok) throw new Error(status.error);
      console.log(`Backup ${status.id} written and checked in ${Math.round(status.durationMs / 1000)}s → ${join(service.backupRoot(), status.id as string)}`);
    } finally {
      await closeDb();
    }
  } else if (command === 'list') {
    const backups = await service.listBackups();
    if (backups.length === 0) console.log(`No backups in ${service.backupRoot()}`);
    for (const b of backups) {
      const size = b.database.bytes + (b.files ?? []).reduce((sum, f) => sum + f.bytes, 0);
      console.log(`${b.id}  ${b.verified?.ok ? 'checked' : 'NOT CHECKED'}  ${(size / 1048576).toFixed(1)} MB  ${b.storageMode}  vault rows: ${b.vault.rows}`);
    }
  } else if (command === 'verify') {
    const { initializeVault } = await import('@/security/vault');
    await initializeVault();
    const result = await service.verifyBackup(await backupDir(rest[0]));
    console.log(result.ok ? 'The backup is good.' : `The backup has problems:\n- ${result.problems.join('\n- ')}`);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'restore') {
    const { initializeVault } = await import('@/security/vault');
    await initializeVault();
    await restore(await backupDir(rest[0]), rest.slice(1));
  } else {
    console.log('Usage: npm run backup [-- list | verify <id> | restore <id> [--database] [--files] [--to <dir>]]');
    process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
});
