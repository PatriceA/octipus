/**
 * Backups (docs/BACKUP.md): the database, which holds the vault (encrypted
 * under the master key), and the workspace files, written to
 * `backup.path/<id>/` with a manifest of what is in them, then checked by
 * loading them back before they count. Old backups are pruned only after a
 * good one. A failed backup tells the admins.
 *
 * - Embedded mode: PGlite's data directory as a tarball. The check loads it
 *   into a fresh in-memory PGlite, counts the vault rows, and decrypts a few
 *   of them with the current master key, so a backup whose key is lost or
 *   different does not pass as good.
 * - External mode: `pg_dump --format=custom`. The check reads the archive's
 *   table of contents (`pg_restore --list`) and finds the vault's data in it;
 *   the key is checked against the live database at backup time.
 * - Files: the workspace root (documents, space files, plugin packages) and
 *   the documents directory when it lies elsewhere, as one `tar.gz`; the
 *   check lists it.
 *
 * The master key is never written into a backup. Without it the vault in a
 * backup cannot be read: keep it apart (see docs/BACKUP.md).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getConfig } from '@/config';
import { getNotificationService } from '@/core/notification-service';
import { dumpEmbeddedDatabase, queryRaw, storageMode } from '@/db/postgres';
import { userRepository } from '@/db/repositories/user-repository';
import { decryptRow } from '@/security/vault';
import { coreLogger } from '@/utils/logger';
import { runCommand } from '@/utils/proc';

export const MANIFEST = 'manifest.json';
const STATUS = 'last-run.json';
const ID_RE = /^\d{8}T\d{6}Z$/;
/** How many vault rows the check decrypts. */
const KEY_CHECK_ROWS = 3;

export interface BackupManifest {
  format: 1;
  id: string;
  createdAt: string;
  reason: 'scheduled' | 'manual';
  octipusVersion: string;
  storageMode: 'embedded' | 'external';
  database: { file: string; kind: 'pglite' | 'pg_dump'; bytes: number; sha256: string };
  vault: { rows: number; keyChecked: boolean };
  files: { file: string; bytes: number; sha256: string; roots: string[] } | null;
  verified?: { at: string; ok: boolean; problems: string[] };
}

export interface BackupRunStatus {
  at: string;
  ok: boolean;
  id?: string;
  error?: string;
  durationMs: number;
  reason: 'scheduled' | 'manual';
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** The backup directory, resolved. */
export function backupRoot(): string {
  return resolve(expandHome(getConfig().backup.path));
}

/** A backup's id from its time: `20261023T020000Z`. */
export function backupId(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The vault's row count, and whether the current master key decrypts a few of its rows. */
async function vaultKeyCheck(query: (sql: string) => Promise<{ rows: any[] }>): Promise<{ rows: number; keyChecked: boolean; problem?: string }> {
  const count = Number((await query('SELECT count(*)::int AS n FROM vault')).rows[0]?.n ?? 0);
  if (count === 0) return { rows: 0, keyChecked: false };
  const { rows } = await query(
    `SELECT user_id AS "userId", scope, workspace_id AS "workspaceId", key_version AS "keyVersion",
            encrypted_value AS "encryptedValue", encryption_iv AS "encryptionIv", encryption_auth_tag AS "encryptionAuthTag"
       FROM vault ORDER BY created_at DESC LIMIT ${KEY_CHECK_ROWS}`,
  );
  for (const row of rows) {
    try {
      decryptRow(row);
    } catch {
      return { rows: count, keyChecked: false, problem: 'The current master key does not decrypt the vault in this backup' };
    }
  }
  return { rows: count, keyChecked: true };
}

/** `pg_dump` connection settings from the database URL, the password in the environment, never in the arguments. */
function pgEnv(): { args: string[]; env: Record<string, string> } {
  const url = new URL(getConfig().database.url);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  const args = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', decodeURIComponent(url.pathname.slice(1))];
  return { args, env };
}

async function dumpDatabase(dir: string): Promise<BackupManifest['database']> {
  if (storageMode() === 'embedded') {
    const file = 'database.tar.gz';
    await writeFile(join(dir, file), await dumpEmbeddedDatabase(), { mode: 0o600 });
    return { file, kind: 'pglite', ...(await sha256File(join(dir, file))) };
  }
  const file = 'database.dump';
  const { args, env } = pgEnv();
  const result = await runCommand({ command: 'pg_dump', args: [...args, '--format=custom', '--no-owner', '-f', join(dir, file)], env }).catch((err: Error) => {
    throw new BackupError(`pg_dump could not run (${err.message}); install the PostgreSQL client tools`);
  });
  if (result.exitCode !== 0) throw new BackupError(`pg_dump failed: ${result.stderr.trim().slice(0, 300)}`);
  await chmod(join(dir, file), 0o600);
  return { file, kind: 'pg_dump', ...(await sha256File(join(dir, file))) };
}

/** The directories the files archive holds: the workspace root, and the documents directory when it lies elsewhere. */
function fileRoots(): string[] {
  const config = getConfig();
  const roots: string[] = [];
  for (const p of [config.workspace.rootPath, config.workspace.documentsPath]) {
    if (!p) continue;
    const abs = resolve(expandHome(p));
    if (!roots.some((r) => within(abs, r))) roots.push(abs);
  }
  return roots;
}

async function archiveFiles(dir: string, backupDir: string): Promise<BackupManifest['files']> {
  const roots: string[] = [];
  for (const root of fileRoots()) {
    if ((await stat(root).catch(() => null))?.isDirectory()) roots.push(root);
  }
  if (roots.length === 0) return null;
  const file = 'files.tar.gz';
  const excludes = [backupDir, process.env.DATA_DIR || getConfig().database?.dataDir]
    .filter((p): p is string => !!p)
    .map((p) => resolve(expandHome(p)));
  const args = ['-czf', join(dir, file)];
  for (const ex of excludes) {
    for (const root of roots) {
      if (within(ex, root)) args.push(`--exclude=${join(basename(root), relative(root, ex))}`);
    }
  }
  for (const root of roots) args.push('-C', dirname(root), basename(root));
  const result = await runCommand({ command: 'tar', args }).catch((err: Error) => {
    throw new BackupError(`tar could not run: ${err.message}`);
  });
  // GNU tar exits 1 when a file changed while it was read: the archive is still whole.
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new BackupError(`tar failed: ${result.stderr.trim().slice(0, 300)}`);
  await chmod(join(dir, file), 0o600);
  return { file, ...(await sha256File(join(dir, file))), roots };
}

/**
 * Check a backup by loading it back: every file's checksum, then the
 * database (see the module comment) and the files archive. Writes the
 * outcome into the manifest.
 */
export async function verifyBackup(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as BackupManifest;
  for (const part of [manifest.database, manifest.files].filter(Boolean) as Array<{ file: string; sha256: string }>) {
    const actual = await sha256File(join(dir, part.file)).catch(() => null);
    if (!actual) problems.push(`${part.file} is missing`);
    else if (actual.sha256 !== part.sha256) problems.push(`${part.file} does not match its checksum`);
  }
  if (problems.length === 0) {
    if (manifest.database.kind === 'pglite') {
      const { PGlite } = await import('@electric-sql/pglite');
      const { vector } = await import('@electric-sql/pglite-pgvector');
      const raw = await readFile(join(dir, manifest.database.file));
      const restored = await PGlite.create({ loadDataDir: new Blob([new Uint8Array(raw)]), extensions: { vector } });
      try {
        const vault = await vaultKeyCheck((sql) => restored.query(sql));
        if (vault.rows !== manifest.vault.rows) problems.push(`The restored vault has ${vault.rows} rows, the backup recorded ${manifest.vault.rows}`);
        if (vault.problem) problems.push(vault.problem);
      } catch (err) {
        problems.push(`The database could not be loaded back: ${(err as Error).message}`);
      } finally {
        await restored.close();
      }
    } else {
      const list = await runCommand({ command: 'pg_restore', args: ['--list', join(dir, manifest.database.file)] }).catch((err: Error) => ({ exitCode: -1, stdout: '', stderr: err.message }));
      if (list.exitCode !== 0) problems.push(`pg_restore cannot read the dump: ${list.stderr.trim().slice(0, 200)}`);
      else if (!/TABLE DATA \S+ vault /.test(list.stdout)) problems.push('The dump holds no vault data');
    }
    if (manifest.files) {
      const list = await runCommand({ command: 'tar', args: ['-tzf', join(dir, manifest.files.file)] }).catch((err: Error) => ({ exitCode: -1, stdout: '', stderr: err.message }));
      if (list.exitCode !== 0) problems.push(`The files archive cannot be read: ${list.stderr.trim().slice(0, 200)}`);
    }
  }
  manifest.verified = { at: new Date().toISOString(), ok: problems.length === 0, problems };
  await writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { ok: problems.length === 0, problems };
}

/** The backups in the backup directory, newest first. */
export async function listBackups(root = backupRoot()): Promise<BackupManifest[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const out: BackupManifest[] = [];
  for (const name of names.filter((n) => ID_RE.test(n))) {
    try {
      out.push(JSON.parse(await readFile(join(root, name, MANIFEST), 'utf8')) as BackupManifest);
    } catch { /* not a complete backup */ }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Keep the newest `keep` good backups; remove older backups (good or not)
 * and leftovers of runs that never finished. Runs only after a good backup,
 * so a series of failures never removes the last good one.
 */
export async function pruneBackups(keep: number, root = backupRoot(), now = new Date()): Promise<string[]> {
  const removed: string[] = [];
  const backups = await listBackups(root);
  const good = backups.filter((b) => b.verified?.ok);
  const keepIds = new Set(good.slice(0, keep).map((b) => b.id));
  const oldestKept = good[Math.min(keep, good.length) - 1]?.id;
  for (const b of backups) {
    // A failed backup newer than the oldest kept good one stays, to be looked at.
    if (keepIds.has(b.id) || (!b.verified?.ok && oldestKept && b.id > oldestKept)) continue;
    await rm(join(root, b.id), { recursive: true, force: true });
    removed.push(b.id);
  }
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.endsWith('.partial')) continue;
    const info = await stat(join(root, name)).catch(() => null);
    if (info && now.getTime() - info.mtimeMs > 24 * 60 * 60_000) await rm(join(root, name), { recursive: true, force: true });
  }
  return removed;
}

export async function lastRun(root = backupRoot()): Promise<BackupRunStatus | null> {
  try {
    return JSON.parse(await readFile(join(root, STATUS), 'utf8')) as BackupRunStatus;
  } catch {
    return null;
  }
}

async function notifyAdmins(error: string): Promise<void> {
  for (const admin of await userRepository.listAdmins()) {
    await getNotificationService()
      .notify(admin.id, 'backup_failed', 'Backup failed', error.slice(0, 500), {}, { workspaceId: null })
      .catch((err: unknown) => coreLogger.warn({ err }, 'backup: could not notify an admin'));
  }
}

let running: Promise<BackupRunStatus> | null = null;

/** Whether a backup is running in this process. */
export function backupRunning(): boolean {
  return running !== null;
}

/**
 * Write, check and keep one backup. Never throws: the outcome is returned,
 * written to `last-run.json`, and on failure sent to the admins.
 * A second call while one runs gets the running one's outcome.
 */
export function runBackup(reason: BackupRunStatus['reason'] = 'manual', now = new Date()): Promise<BackupRunStatus> {
  running ??= doBackup(reason, now).finally(() => { running = null; });
  return running;
}

async function doBackup(reason: BackupRunStatus['reason'], now: Date): Promise<BackupRunStatus> {
  const started = Date.now();
  const root = backupRoot();
  const id = backupId(now);
  const partial = join(root, `${id}.partial`);
  let status: BackupRunStatus;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await stat(join(root, id)).catch(() => null)) !== null) throw new BackupError(`A backup ${id} already exists`);
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { mode: 0o700 });
    const database = await dumpDatabase(partial);
    const vault = await vaultKeyCheck((sql) => queryRaw(sql));
    if (vault.problem) throw new BackupError(vault.problem);
    const files = getConfig().backup.includeFiles ? await archiveFiles(partial, root) : null;
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8').catch(() => '{}')) as { version?: string };
    const manifest: BackupManifest = {
      format: 1, id, createdAt: now.toISOString(), reason, octipusVersion: pkg.version ?? 'unknown',
      storageMode: storageMode(), database, vault: { rows: vault.rows, keyChecked: vault.keyChecked }, files,
    };
    await writeFile(join(partial, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const check = await verifyBackup(partial);
    if (!check.ok) throw new BackupError(`The backup did not pass its check: ${check.problems.join('; ')}`);
    await rename(partial, join(root, id));
    await pruneBackups(getConfig().backup.keep, root, now);
    status = { at: now.toISOString(), ok: true, id, durationMs: Date.now() - started, reason };
    coreLogger.info({ id, durationMs: status.durationMs }, 'backup: written and checked');
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    status = { at: now.toISOString(), ok: false, error, durationMs: Date.now() - started, reason };
    coreLogger.error({ err }, 'backup: failed');
    await notifyAdmins(error);
  }
  await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeFile(join(root, STATUS), JSON.stringify(status, null, 2), { mode: 0o600 }).catch(() => undefined);
  return status;
}

/**
 * The cron tick's check: once a day, in the configured hour, when no run
 * (good or failed) happened in the last 20 hours. Not awaited by the tick.
 */
export async function maybeRunScheduledBackup(now = new Date()): Promise<BackupRunStatus | null> {
  const config = getConfig().backup;
  if (!config.enabled || now.getHours() !== config.hour || backupRunning()) return null;
  const last = await lastRun();
  if (last && now.getTime() - Date.parse(last.at) < 20 * 60 * 60_000) return null;
  return runBackup('scheduled', now);
}
