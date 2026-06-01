/**
 * Session-scoped file access for the in-chat file view —
 * `.octipus/end-user-ux-design.md` Thread 2.
 *
 * Thin, testable layer over `WorkspaceFS`: the API routes
 * (`GET/PUT /api/sessions/:id/files`) call these functions with a per-user
 * `WorkspaceFS` so containment (the H2/SSRF-grade path resolver), null-byte
 * rejection, and tenant isolation are all inherited rather than re-implemented.
 *
 * Versioning: every read returns an opaque `version` (content+mtime hash) the
 * client echoes back on write. A stale write is rejected *loudly* (409) per
 * DESIGN.md fail-loud — that's the concurrency story for edit-and-continue,
 * where the user edits a file the agent might also be touching.
 *
 * Scope guard (design Thread 1): we cap the readable size so the in-chat
 * viewer can't pull a 500 MB file into the browser; large files report their
 * size and `tooLarge` instead of a body.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { type WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';

/** Hard ceiling for an in-chat read/write. 1 MiB is plenty for a doc/code file. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Typed error the routes map to an HTTP status. */
export class SessionFileError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SessionFileError';
    this.status = status;
    this.code = code;
  }
}

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

export type ReadFileResult =
  | { type: 'directory'; path: string; entries: DirEntry[] }
  | { type: 'text'; path: string; content: string; version: string; size: number; modifiedAt: string }
  | { type: 'image'; path: string; dataUrl: string; mimeType: string; version: string; size: number; modifiedAt: string }
  | { type: 'binary'; path: string; version: string; size: number; modifiedAt: string }
  | { type: 'too-large'; path: string; size: number };

/** Opaque version tag — content + mtime so an out-of-band edit is detected. */
function computeVersion(content: Buffer, mtimeMs: number): string {
  return createHash('sha256')
    .update(content)
    .update(String(Math.floor(mtimeMs)))
    .digest('hex')
    .slice(0, 16);
}

/** Heuristic binary sniff: a NUL byte in the first 8 KiB ⇒ treat as binary. */
function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8192);
  return window.includes(0);
}

/** Translate a low-level fs/WorkspaceFS error into a typed SessionFileError. */
function mapFsError(err: unknown): SessionFileError {
  if (err instanceof WorkspaceFsError) {
    // INVALID_INPUT (null byte / non-string) is a client error; the rest are
    // containment violations — both surface as 400 (never leak the real path).
    return new SessionFileError(400, 'invalid_path', err.message);
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return new SessionFileError(404, 'not_found', 'File not found');
  if (code === 'EISDIR') return new SessionFileError(400, 'is_directory', 'Path is a directory');
  if (code === 'EACCES') return new SessionFileError(403, 'forbidden', 'Permission denied');
  if (err instanceof SessionFileError) return err;
  throw err; // unexpected — fail loud
}

/**
 * Read a session file (or list a directory). `path` may be relative to the
 * workspace root or an absolute path inside it (the work-stream `file` result
 * hands the UI a resolved absolute path); `WorkspaceFS.resolve` vets both.
 */
export async function readSessionFile(fs: WorkspaceFS, path: string): Promise<ReadFileResult> {
  let resolved: string;
  try {
    resolved = fs.resolve(path);
  } catch (err) {
    throw mapFsError(err);
  }

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(resolved);
  } catch (err) {
    throw mapFsError(err);
  }

  if (st.isDirectory()) {
    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      const isDir = d.isDirectory();
      let size: number | undefined;
      if (!isDir) {
        try {
          size = (await stat(`${resolved}/${d.name}`)).size;
        } catch {
          /* entry vanished between readdir and stat — skip its size */
        }
      }
      entries.push({ name: d.name, path: `${path.replace(/\/+$/, '')}/${d.name}`, isDirectory: isDir, size });
    }
    entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    return { type: 'directory', path: resolved, entries };
  }

  if (st.size > MAX_FILE_BYTES) {
    return { type: 'too-large', path: resolved, size: st.size };
  }

  const buf = await readFile(resolved);
  const version = computeVersion(buf, st.mtimeMs);
  const meta = { version, size: st.size, modifiedAt: st.mtime.toISOString() };

  const ext = extname(resolved).toLowerCase();
  const imageMime = IMAGE_EXT[ext];
  if (imageMime && ext !== '.svg') {
    return { type: 'image', path: resolved, mimeType: imageMime, dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`, ...meta };
  }
  if (looksBinary(buf)) {
    return { type: 'binary', path: resolved, ...meta };
  }
  return { type: 'text', path: resolved, content: buf.toString('utf-8'), ...meta };
}

export interface WriteFileResult {
  path: string;
  version: string;
  size: number;
  modifiedAt: string;
}

/**
 * Write a session file. When `baseVersion` is supplied it must match the
 * current on-disk version or the write is rejected (409) — this is the
 * optimistic-concurrency guard for edit-and-continue. Omitting `baseVersion`
 * (e.g. creating a new file) skips the check.
 */
export async function writeSessionFile(
  fs: WorkspaceFS,
  path: string,
  content: string,
  baseVersion?: string,
): Promise<WriteFileResult> {
  if (typeof content !== 'string') {
    throw new SessionFileError(400, 'invalid_body', 'content must be a string');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
    throw new SessionFileError(413, 'too_large', `content exceeds ${MAX_FILE_BYTES} bytes`);
  }

  let resolved: string;
  try {
    resolved = fs.resolve(path);
  } catch (err) {
    throw mapFsError(err);
  }

  // Concurrency check against the current on-disk version.
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) throw new SessionFileError(400, 'is_directory', 'Path is a directory');
    if (baseVersion !== undefined) {
      const current = computeVersion(await readFile(resolved), st.mtimeMs);
      if (current !== baseVersion) {
        throw new SessionFileError(409, 'stale_version', 'File changed since it was loaded; reload before saving');
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw mapFsError(err);
    // ENOENT → new file. A baseVersion on a non-existent file is a stale write.
    if (baseVersion !== undefined) {
      throw new SessionFileError(409, 'stale_version', 'File no longer exists; reload before saving');
    }
  }

  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf-8');

  const st = await stat(resolved);
  return {
    path: resolved,
    version: computeVersion(Buffer.from(content, 'utf-8'), st.mtimeMs),
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
}

/** Pretty display name for a path — the last segment. */
export function fileDisplayName(path: string): string {
  return basename(path.replace(/[/\\]+$/, ''));
}
