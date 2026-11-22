/**
 * Bridge between the TUI editor and the local filesystem.
 *
 * The editor uses `node:fs` synchronously for read / write — the TUI runs
 * locally and a single file (at most 5 MB) does not justify async
 * indirection.
 *
 * Reading hands the buffer text with `\n` line ends and remembers what the
 * file looked like on disk (line endings, byte-order mark, mode, mtime,
 * size), so saving writes it back the same way. A file the editor would
 * change by saving it unedited — binary, not UTF-8 — is refused with the
 * reason instead of opened, and so is anything that is not a regular file
 * (a FIFO would block the read until something writes to it, a device
 * might never end).
 *
 * Saving is atomic: the text goes to a temporary file next to the target,
 * which is flushed and renamed over it, so a crash or a full disk leaves the
 * old file rather than half of the new one. The temporary file takes the
 * original's mode, and its owner and group when they are not this user's.
 * A file with more than one hard link is written in place, since a rename
 * would detach it from its other names; so is a file whose owner cannot be
 * kept, or whose folder does not let the temporary file be created.
 *
 * Failures come back as `{ ok: false, error }` with a sentence the editor
 * shows as it is.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Stats } from 'node:fs';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB safety cap per buffer
const BOM = '﻿';

export type LineEnding = '\n' | '\r\n';

/** What the file was on disk when it was last read or written. */
export interface DiskInfo {
  mtimeMs: number;
  size: number;
  eol: LineEnding;
  bom: boolean;
  mode: number;
}

export type ReadResult =
  | { ok: true; text: string; disk: DiskInfo; mixedEol: boolean }
  | { ok: false; error: string };

export type WriteResult = { ok: true; disk: DiskInfo } | { ok: false; error: string };

export function readFileForBuffer(absPath: string): ReadResult {
  let bytes: globalThis.Buffer;
  let stat: Stats;
  try {
    stat = statSync(absPath);
    if (stat.isDirectory()) return { ok: false, error: `${absPath} is a folder.` };
    // A FIFO blocks the read until something writes to it, a device can be endless: only regular files are read.
    if (!stat.isFile()) return { ok: false, error: `${absPath} is not a regular file (${kindOf(stat)}); not opened.` };
    if (stat.size > MAX_BYTES) return { ok: false, error: `${absPath} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the editor opens files up to 5 MB.` };
    bytes = readFileSync(absPath);
  } catch (error) {
    return { ok: false, error: `Cannot read ${absPath}: ${describe(error)}.` };
  }
  if (bytes.includes(0)) return { ok: false, error: `${absPath} looks binary (it contains NUL bytes); not opened.` };
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    // A fatal decoder throws a TypeError on bytes that are not UTF-8; anything else is not that.
    if (!(error instanceof TypeError)) throw error;
    return { ok: false, error: `${absPath} is not valid UTF-8; not opened, so saving cannot rewrite it in another encoding.` };
  }
  const bom = decoded.startsWith(BOM);
  const body = bom ? decoded.slice(1) : decoded;
  const crlf = body.match(/\r\n/g)?.length ?? 0;
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf;
  const eol: LineEnding = crlf > lf ? '\r\n' : '\n';
  return {
    ok: true,
    // Only CRLF pairs are line ends; a lone CR stays in the text and is shown as ␍.
    text: body.replace(/\r\n/g, '\n'),
    disk: { mtimeMs: stat.mtimeMs, size: stat.size, eol, bom, mode: stat.mode & 0o7777 },
    mixedEol: crlf > 0 && lf > 0,
  };
}

/** The bytes a buffer's text becomes on disk. */
export function encodeForDisk(text: string, format: Pick<DiskInfo, 'eol' | 'bom'>): globalThis.Buffer {
  const body = format.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  return globalThis.Buffer.from((format.bom ? BOM : '') + body, 'utf8');
}

/**
 * Write `text` to `absPath` atomically. `format` is the file's own (from the
 * last read); `null` for a new file: `\n`, no BOM, the default mode.
 */
export function writeFileForBuffer(absPath: string, text: string, format: Pick<DiskInfo, 'eol' | 'bom' | 'mode'> | null): WriteResult {
  const eol = format?.eol ?? '\n';
  const bom = format?.bom ?? false;
  const data = encodeForDisk(text, { eol, bom });
  let target = absPath;
  let existing: Stats | null = null;
  try {
    // Write through a symlink to the file it names, rather than replacing the link.
    if (lstatSync(absPath).isSymbolicLink()) target = realpathSync(absPath);
    existing = statSync(target);
  } catch (error) {
    if (!isMissing(error)) return { ok: false, error: `Cannot save ${absPath}: ${describe(error)}.` };
  }
  try {
    if (existing && existing.nlink > 1) writeInPlace(target, data);
    else writeViaRename(target, data, format?.mode ?? (existing ? existing.mode & 0o7777 : null), existing);
    const stat = statSync(target);
    return { ok: true, disk: { mtimeMs: stat.mtimeMs, size: stat.size, eol, bom, mode: stat.mode & 0o7777 } };
  } catch (error) {
    return { ok: false, error: `Cannot save ${absPath}: ${describe(error)}.` };
  }
}

/**
 * Write through a temporary file renamed over the target. The temporary
 * file is created by this process, so it is owned by its user: when the
 * original belongs to someone else (a shared group file, a file written
 * under sudo) it is given the original's owner and group first. Where that
 * is not allowed (EPERM: not root, not the owner), or the temporary file
 * cannot be created at all (EACCES / EPERM / EROFS on the folder, while the
 * file itself is writable), the file is written in place instead — not
 * atomic, but it keeps its owner rather than being handed to this user or
 * not saved at all. Returns how it was written.
 */
function writeViaRename(target: string, data: globalThis.Buffer, mode: number | null, existing: Stats | null): 'rename' | 'in-place' {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString('hex')}.octipus-save`);
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', mode ?? 0o666);
  } catch (error) {
    if (existing && isDenied(error)) { writeInPlace(target, data); return 'in-place'; }
    throw error;
  }
  try {
    if (existing) {
      const own = fstatSync(fd);
      if (own.uid !== existing.uid || own.gid !== existing.gid) {
        try {
          fchownSync(fd, existing.uid, existing.gid);
        } catch (error) {
          if (!isDenied(error)) throw error;
          // Not allowed to give the file its owner back: write it in place, where it keeps them.
          closeSync(fd);
          unlinkSync(tmp);
          writeInPlace(target, data);
          return 'in-place';
        }
      }
    }
    writeAll(fd, data);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  try {
    // The umask applies at creation; the original's mode is what it should keep.
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
  return 'rename';
}

function writeInPlace(target: string, data: globalThis.Buffer): void {
  const fd = openSync(target, 'w');
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: globalThis.Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

/**
 * Whether the file is no longer what the buffer was loaded from or last
 * saved as: deleted, or different content. A touch that leaves the content
 * as it was is not a change (the caller refreshes its `DiskInfo`).
 */
export function checkDisk(absPath: string, disk: DiskInfo, savedText: string): { changed: false; disk: DiskInfo } | { changed: true; deleted: boolean } {
  let stat: Stats;
  try {
    stat = statSync(absPath);
  } catch (error) {
    if (isMissing(error)) return { changed: true, deleted: true };
    throw error;
  }
  if (stat.mtimeMs === disk.mtimeMs && stat.size === disk.size) return { changed: false, disk };
  const now = readFileForBuffer(absPath);
  if (now.ok && now.text === savedText) return { changed: false, disk: { ...disk, mtimeMs: now.disk.mtimeMs, size: now.disk.size } };
  return { changed: true, deleted: false };
}

/** Not allowed: by permissions, ownership, or a read-only file system. */
function isDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function kindOf(stat: Stats): string {
  if (stat.isFIFO()) return 'a pipe';
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return 'a device';
  if (stat.isSocket()) return 'a socket';
  return 'not a file';
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === 'ENOENT') return 'no such file or folder';
    if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
    if (code === 'ENOSPC') return 'the disk is full';
    if (code === 'EROFS') return 'the file system is read-only';
  }
  return error instanceof Error ? error.message : String(error);
}
