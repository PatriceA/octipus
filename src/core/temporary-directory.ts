import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreLogger } from '@/utils/logger';

interface Owner {
  version: 1;
  token: string;
  ownerPid: number;
  released: boolean;
  childPid?: number;
  group?: boolean;
}

export interface ManagedTemporaryDirectory {
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  /** Attach the actual child, not a caller-supplied PID. */
  attach(pid: number | undefined, group?: boolean): void;
  /** Request cleanup after process termination. Active descendants retain it. */
  dispose(): void;
}

const bases = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
const OWNER_FILE = 'owner.json';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function childAlive(owner: Owner): boolean {
  if (!owner.childPid) return false;
  if (!owner.group || process.platform === 'win32') return alive(owner.childPid);
  try { process.kill(-owner.childPid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  if (process.platform !== 'linux') return true;
  // A reparented zombie cannot use files but can keep kill(-pgid, 0) alive.
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${entry}/stat`, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') continue; return true; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === owner.childPid && fields[0] !== 'Z') return true;
    }
    return false;
  } catch { return true; } // Cannot prove quiescence: retain the files.
}

function readOwner(root: string): Owner | null {
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return null;
    const marker = lstatSync(join(root, OWNER_FILE));
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 4096) return null;
    const data: unknown = JSON.parse(readFileSync(join(root, OWNER_FILE), 'utf8'));
    if (!data || typeof data !== 'object') return null;
    const o = data as Partial<Owner>;
    if (o.version !== 1 || typeof o.token !== 'string' || !/^[0-9a-f-]{36}$/.test(o.token)
      || !Number.isSafeInteger(o.ownerPid) || (o.ownerPid ?? 0) <= 0 || typeof o.released !== 'boolean'
      || (o.childPid !== undefined && (!Number.isSafeInteger(o.childPid) || o.childPid <= 0))
      || (o.group !== undefined && typeof o.group !== 'boolean')) return null;
    return o as Owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') coreLogger.warn({ err: error, root }, 'Temporary directory ownership could not be read; retaining it');
    return null;
  }
}

function removeIfFinished(root: string, expectedToken?: string): boolean {
  const owner = readOwner(root);
  if (!owner || (expectedToken && owner.token !== expectedToken)) return false;
  if (!owner.released && alive(owner.ownerPid)) return false;
  // A crash between allocation and recording spawn has an unknown outcome.
  if (!owner.released && owner.childPid === undefined) return false;
  if (childAlive(owner)) return false;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); return true; }
  catch (error) { coreLogger.warn({ err: error, root }, 'Temporary directory cleanup failed; will retry'); return false; }
}

/** Only the private managed base is swept; never match arbitrary /tmp names. */
export function sweepTemporaryDirectories(base = join(tmpdir(), `octipus-owned-temp-${process.getuid?.() ?? 'user'}`)): number {
  let count = 0;
  try {
    const stat = lstatSync(base);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return 0;
    for (const name of readdirSync(base)) if (/^run-[A-Za-z0-9]+$/.test(name) && removeIfFinished(join(base, name))) count++;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') coreLogger.warn({ err: error, base }, 'Managed temporary directory sweep failed');
  }
  return count;
}

/** Local commands and CLI invocations inherit this private scratch directory. */
export function createManagedTemporaryDirectory(): ManagedTemporaryDirectory {
  const base = join(realpathSync(tmpdir()), `octipus-owned-temp-${process.getuid?.() ?? 'user'}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Managed temporary directory base is not an owned directory');
  sweepTemporaryDirectories(base);
  bases.add(base);
  if (!timer) {
    timer = setInterval(() => { for (const path of bases) sweepTemporaryDirectories(path); }, 60_000);
    timer.unref();
  }
  const root = mkdtempSync(join(base, 'run-'));
  const inode = lstatSync(root).ino;
  const dir = join(root, 'files');
  const owner: Owner = { version: 1, token: randomUUID(), ownerPid: process.pid, released: false };
  const save = () => {
    if (lstatSync(root).ino !== inode || lstatSync(root).isSymbolicLink()) throw new Error('Managed temporary directory ownership changed');
    const path = join(root, OWNER_FILE);
    writeFileSync(`${path}.new`, JSON.stringify(owner), { mode: 0o600 });
    renameSync(`${path}.new`, path);
  };
  try {
    mkdirSync(dir, { mode: 0o700 });
    save();
  } catch (error) {
    // No process has been launched yet; this freshly allocated root is ours.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    dir,
    env: { TMPDIR: dir, TMP: dir, TEMP: dir },
    attach(pid, group = false) {
      if (pid !== undefined && !disposed) {
        owner.childPid = pid; owner.group = group;
        try { save(); }
        catch (error) { coreLogger.warn({ err: error, root }, 'Could not record temporary directory child ownership; retaining it on uncertainty'); }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      owner.released = true;
      try { save(); removeIfFinished(root, owner.token); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') coreLogger.warn({ err: error, root }, 'Temporary cleanup could not establish ownership; retaining directory'); }
    },
  };
}
