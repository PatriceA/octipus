/**
 * Unpacking a downloaded plugin package (`.tar.gz`) into an empty directory
 * (docs/PLUGIN-PACKAGES.md#remote-install).
 *
 * A minimal reader of POSIX ustar, with the pax (`x`) and GNU long-name (`L`)
 * headers that `tar` and `npm pack` write for long paths. It takes regular
 * files and directories only, and refuses the whole archive on anything
 * else, with the same rules a directory install applies (./tree.ts): no
 * symbolic or hard links, no devices, FIFOs or other special entries. Every
 * path must stay inside the target: no absolute path, no drive letter, no
 * backslash, no `..` segment, no NUL. A path that appears twice is refused
 * (a second entry could replace a reviewed file). Files are written with
 * `wx` (never through anything already there) and modes 0644 or 0755 only.
 * The archive is bounded before it is read (the gunzip output cap) and while
 * it is written (bytes and file count of ./tree.ts).
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from './tree';

const BLOCK = 512;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export interface TarLimits {
  maxBytes: number;
  maxFiles: number;
}

const DEFAULT_LIMITS: TarLimits = { maxBytes: MAX_PACKAGE_BYTES, maxFiles: MAX_PACKAGE_FILES };

/** The entry types refused, by name, for the message. */
const REFUSED_TYPES: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  K: 'a GNU long link name',
  S: 'a sparse file',
  V: 'a volume header',
  M: 'a multi-volume continuation',
};

function cString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number, what: string): number {
  if ((block[start] & 0x80) !== 0) throw new TarError(`The archive uses a base-256 ${what}, which this reader does not take`);
  const text = cString(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`The archive has an unreadable ${what} ("${text}")`);
  return Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  const recorded = octal(block, 148, 8, 'header checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === recorded;
}

/**
 * The relative, `/`-separated path an entry names, or null for the archive
 * root itself (`./`). Throws for anything that could leave the target.
 */
export function safeEntryPath(raw: string): string | null {
  if (raw.includes('\0')) throw new TarError('An entry name contains a NUL byte');
  if (raw.includes('\\')) throw new TarError(`An entry name contains a backslash (${JSON.stringify(raw)})`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new TarError(`An entry has an absolute path (${JSON.stringify(raw)})`);
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new TarError(`An entry leaves the package directory (${JSON.stringify(raw)})`);
  return parts.length === 0 ? null : parts.join('/');
}

/** The records of a pax extended header (`<len> <key>=<value>\n`...). */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const len = Number.parseInt(data.subarray(off, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= space - off || off + len > data.length) throw new TarError('The archive has a malformed pax header');
    const record = data.subarray(space + 1, off + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    off += len;
  }
  return records;
}

/** One entry of the archive: a directory, or a regular file with its bytes and mode. */
type Entry = { kind: 'dir'; path: string | null } | { kind: 'file'; path: string; data: Buffer; mode: number };

/** Read every entry of an uncompressed tar, refusing what a package may not contain. */
export function readTarEntries(tar: Buffer): Entry[] {
  const entries: Entry[] = [];
  let off = 0;
  let longPath: string | null = null;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let ended = false;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(header)) throw new TarError('The archive is corrupt (a header checksum does not match)');
    const type = String.fromCharCode(header[156] || 0x30);
    const name = cString(header, 0, 100);
    const ustar = header.subarray(257, 262).toString('ascii') === 'ustar';
    const prefix = ustar ? cString(header, 345, 155) : '';
    const headerSize = octal(header, 124, 12, 'size');
    const extended = type === 'x' || type === 'g' || type === 'L';
    const size = extended ? headerSize : paxSize ?? headerSize;
    off += BLOCK;
    if (off + size > tar.length) throw new TarError('The archive is truncated');
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      const records = paxRecords(data);
      if (records.has('linkpath')) throw new TarError('The archive names a link target (pax linkpath)');
      paxPath = records.get('path') ?? null;
      const s = records.get('size');
      if (s !== undefined) {
        if (!/^\d+$/.test(s)) throw new TarError('The archive has an unreadable pax size');
        paxSize = Number.parseInt(s, 10);
      }
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longPath = cString(data, 0, data.length);
      continue;
    }
    const rawPath = paxPath ?? longPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    longPath = null;
    paxSize = null;
    const refused = REFUSED_TYPES[type];
    if (refused) throw new TarError(`The archive contains ${refused} (${JSON.stringify(rawPath)}); a package holds regular files only`);
    const path = safeEntryPath(rawPath);
    if (type === '5') {
      entries.push({ kind: 'dir', path });
    } else if (type === '0' || type === '7') {
      if (path === null) throw new TarError('A file entry has no name');
      entries.push({ kind: 'file', path, data, mode: octal(header, 100, 8, 'mode') });
    } else {
      throw new TarError(`The archive contains an entry of unknown type "${type}" (${JSON.stringify(rawPath)})`);
    }
  }
  if (!ended && off < tar.length) throw new TarError('The archive is truncated');
  if (longPath !== null || paxPath !== null) throw new TarError('The archive ends inside an extended header');
  return entries;
}

/**
 * Unpack a gzip-compressed tar into `dest`, an empty directory the caller
 * made. Throws `TarError` (and leaves whatever was written for the caller to
 * remove) on the first thing a package may not contain.
 */
export async function extractTarGz(gz: Buffer, dest: string, limits: TarLimits = DEFAULT_LIMITS): Promise<void> {
  // Headers and padding on top of the content: at most two blocks per file, plus the end.
  const maxTar = limits.maxBytes + (limits.maxFiles * 2 + 64) * BLOCK;
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: maxTar });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      throw new TarError(`The archive unpacks to more than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
    }
    throw new TarError(`The download is not a gzip archive: ${(err as Error).message}`);
  }
  const entries = readTarEntries(tar);
  const root = resolve(dest);
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.path === null) continue;
    const target = resolve(root, ...entry.path.split('/'));
    if (!target.startsWith(root + sep)) throw new TarError(`An entry leaves the package directory (${JSON.stringify(entry.path)})`);
    if (entry.kind === 'dir') {
      try {
        await mkdir(target, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTDIR') throw new TarError(`The archive's ${JSON.stringify(entry.path)} collides with another entry`);
        throw err;
      }
      continue;
    }
    if (seen.has(entry.path)) throw new TarError(`The archive contains ${JSON.stringify(entry.path)} twice`);
    seen.add(entry.path);
    files += 1;
    bytes += entry.data.length;
    if (files > limits.maxFiles) throw new TarError(`The package has more than ${limits.maxFiles} files`);
    if (bytes > limits.maxBytes) throw new TarError(`The package is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data, { flag: 'wx', mode: (entry.mode & 0o111) !== 0 ? 0o755 : 0o644 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EISDIR' || code === 'ENOTDIR') throw new TarError(`The archive's ${JSON.stringify(entry.path)} collides with another entry`);
      throw err;
    }
  }
}

/**
 * The package directory inside an unpacked archive: its root when the
 * manifest is there, else its one top-level directory (`package/` from
 * `npm pack`, `<name>-<version>/` from `tar`) when that holds the manifest.
 */
export async function packageRootIn(dir: string): Promise<string> {
  const has = async (d: string) => (await stat(join(d, PLUGIN_MANIFEST_FILE)).catch(() => null))?.isFile() === true;
  if (await has(dir)) return dir;
  const top = await readdir(dir, { withFileTypes: true });
  if (top.length === 1 && top[0].isDirectory() && await has(join(dir, top[0].name))) return join(dir, top[0].name);
  throw new TarError(`The archive has no ${PLUGIN_MANIFEST_FILE} at its root or in its single top-level directory`);
}
