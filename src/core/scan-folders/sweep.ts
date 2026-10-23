/**
 * The scan-folder sweep (docs/SCAN-FOLDERS.md#sweep). Each cron tick looks
 * into every enabled folder and files the files that have settled:
 *
 * - Only regular files directly in the folder, with one link. Symbolic links,
 *   hard links, pipes and devices, directories, hidden files and files still
 *   being written (`.part`, `.tmp`, `~`, or changed in the last `SETTLE_MS`
 *   by their change time, which a writer cannot set back) are left alone. A
 *   file is opened without following links and without blocking, and read
 *   only up to the document limit.
 * - Each file is filed as the folder's author, resolved again and still an
 *   admin; otherwise nothing is filed.
 * - The same content is filed once per folder (`scan_folder_files`).
 * - A filed file is removed from the folder (its document keeps it), after
 *   checking the name still is the file that was read. Nothing is moved or
 *   created in the folder, so nothing planted there can redirect a write.
 * - A file that cannot be filed stays and is not tried again until it
 *   changes; the folder shows why.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { ingestDocument, maxDocumentSize } from '@/core/documents/ingest';
import { getDb } from '@/db/postgres';
import { contentRepos } from '@/db/repositories/content';
import { userRepository } from '@/db/repositories/user-repository';
import { type ScanFolder, scanFolderFiles, scanFolders } from '@/db/schema/scan-folders';
import { writerPrincipal } from '@/security/writer-principal';
import { coreLogger } from '@/utils/logger';

/** A file changed more recently than this is still being written. */
export const SETTLE_MS = 30_000;
/** Files one folder files per tick, and directory entries it looks at; the rest wait for the next. */
const FILES_PER_TICK = 50;
const ENTRIES_PER_TICK = 2_000;
const FOLDERS_PER_TICK = 50;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.eml': 'message/rfc822',
};

export function mimeTypeOf(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** A name the sweep leaves alone: hidden, or a file a program is still writing. */
export function isPending(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~') || /\.(part|tmp|crdownload|partial|download)$/i.test(name) || name.endsWith('~');
}

export interface ScanResult {
  filed: number;
  failed: number;
  error?: string;
}

class NotFileable extends Error {}

/**
 * Read a file that is a regular file with one link, without following a
 * link or blocking on a pipe, at most `max` bytes. Returns its content and
 * identity (to check before removing it).
 */
async function readRegular(path: string, max: number): Promise<{ buffer: Buffer; dev: number; ino: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NotFileable('Not a regular file');
    if (info.nlink > 1) throw new NotFileable('A file with more than one link is not filed');
    if (info.size > max) throw new NotFileable('The file is larger than the document limit');
    // Read to the limit, not to the end: a file still growing cannot push past it.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, max + 1 - total));
      if (chunk.length === 0) throw new NotFileable('The file is larger than the document limit');
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) throw new NotFileable('The file is larger than the document limit');
    }
    return { buffer: Buffer.concat(chunks, total), dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
}

/** Remove `path` if it still is the file that was read (a name swapped meanwhile is left alone). */
async function removeIfSame(path: string, dev: number, ino: number): Promise<void> {
  const now = await lstat(path).catch(() => null);
  if (now && now.isFile() && now.dev === dev && now.ino === ino) await unlink(path);
}

/** Record a file that cannot be filed, so it is not tried again until it changes. */
async function rememberFailure(folderId: string, key: string, name: string, error: string): Promise<void> {
  await getDb()
    .insert(scanFolderFiles)
    .values({ folderId, key, name: name.slice(0, 255), error: error.slice(0, 300) })
    .onConflictDoNothing();
}

/** The folder's author, as a principal that may still file there: active, an admin, a writer in the scope. */
async function folderWriter(folder: ScanFolder) {
  const user = await userRepository.findById(folder.userId);
  if (!user?.isAdmin) return null;
  return writerPrincipal(folder.userId, folder.workspaceId);
}

/** File what has settled in one folder now. Never throws: a failure is recorded on the folder. */
export async function scanFolder(folder: ScanFolder, now = new Date()): Promise<ScanResult> {
  const result: ScanResult = { filed: 0, failed: 0 };
  try {
    // The folder itself must still be the directory that was checked at save.
    const info = await lstat(folder.path);
    if (!info.isDirectory()) throw new Error('The folder is no longer a directory');
    const principal = await folderWriter(folder);
    if (!principal) throw new Error('The admin who set this folder up can no longer add documents here');
    const repos = contentRepos(principal);
    const max = maxDocumentSize();

    let handled = 0;
    let examined = 0;
    const dir = await opendir(folder.path);
    try {
      for await (const entry of dir) {
        if (handled >= FILES_PER_TICK || ++examined > ENTRIES_PER_TICK) break;
        if (!entry.isFile() || isPending(entry.name)) continue;
        const name = entry.name;
        const path = join(folder.path, name);
        const st = await lstat(path).catch(() => null);
        if (!st || !st.isFile() || now.getTime() - Math.max(st.mtimeMs, st.ctimeMs) < SETTLE_MS) continue;
        const failedKey = `failed:${name}:${st.size}:${Math.floor(st.ctimeMs)}`;
        const [known] = await getDb().select({ id: scanFolderFiles.id }).from(scanFolderFiles)
          .where(and(eq(scanFolderFiles.folderId, folder.id), eq(scanFolderFiles.key, failedKey))).limit(1);
        if (known) continue;
        handled++;
        let claimedId: string | null = null;
        let documentId: string | null = null;
        try {
          const read = await readRegular(path, max);
          const key = `sha256:${createHash('sha256').update(read.buffer).digest('hex')}`;
          const [claimed] = await getDb()
            .insert(scanFolderFiles)
            .values({ folderId: folder.id, key, name: name.slice(0, 255) })
            .onConflictDoNothing()
            .returning({ id: scanFolderFiles.id });
          if (claimed) {
            claimedId = claimed.id;
            const doc = await ingestDocument(repos, {
              buffer: read.buffer,
              originalName: name,
              mimeType: mimeTypeOf(name),
              metadata: { source: 'scan_folder', scanFolderId: folder.id, scanFolder: folder.label },
            });
            documentId = doc.id;
            await getDb().update(scanFolderFiles).set({ documentId: doc.id }).where(eq(scanFolderFiles.id, claimed.id));
            if (doc.error) throw new Error(doc.error);
            result.filed++;
          }
          // Filed now or before (the same content): its document has it.
          await removeIfSame(path, read.dev, read.ino);
        } catch (err) {
          // Not filed: give the content back, so it is filed once it can be.
          if (claimedId && !documentId) await getDb().delete(scanFolderFiles).where(eq(scanFolderFiles.id, claimedId)).catch(() => undefined);
          const message = (err as Error).message;
          if (!documentId) {
            result.failed++;
            result.error = `A file could not be filed: ${message}`.slice(0, 300);
            await rememberFailure(folder.id, failedKey, name, message).catch(() => undefined);
          }
          coreLogger.warn({ folderId: folder.id, err: message }, 'scan folder: a file could not be filed'); // no file name logged
        }
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  } catch (err) {
    result.error = (err as Error).message.slice(0, 300);
    coreLogger.warn({ folderId: folder.id, error: result.error }, 'scan folder: scan failed');
  }
  await getDb()
    .update(scanFolders)
    .set({ lastScanAt: now, lastError: result.error ?? null, filed: sql`${scanFolders.filed} + ${result.filed}` })
    .where(eq(scanFolders.id, folder.id));
  return result;
}

/** Folders scanned in this process right now: the sweep and a manual scan never overlap. */
const running = new Set<string>();

/** Scan one folder unless a scan of it is running; null when one is. */
export async function scanFolderOnce(folder: ScanFolder, now = new Date()): Promise<ScanResult | null> {
  if (running.has(folder.id)) return null;
  running.add(folder.id);
  try {
    return await scanFolder(folder, now);
  } finally {
    running.delete(folder.id);
  }
}

/** The cron tick's sweep: enabled folders outside archived spaces, the longest unscanned first. Returns how many files were filed. */
export async function scanDueFolders(now = new Date()): Promise<number> {
  const folders = await getDb()
    .select()
    .from(scanFolders)
    .where(and(
      eq(scanFolders.enabled, true),
      sql`NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${scanFolders.workspaceId} AND w.archived_at IS NOT NULL)`,
    ))
    .orderBy(sql`${scanFolders.lastScanAt} ASC NULLS FIRST`)
    .limit(FOLDERS_PER_TICK);
  let filed = 0;
  for (const folder of folders) filed += (await scanFolderOnce(folder, now))?.filed ?? 0;
  return filed;
}
