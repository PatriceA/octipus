/**
 * The scan-folder sweep (docs/SCAN-FOLDERS.md#sweep). Each cron tick looks
 * into every enabled folder and files the files that have settled:
 *
 * - Only regular files directly in the folder. Symbolic links, directories,
 *   hidden files and files still being written (`.part`, `.tmp`, `~`, or
 *   changed in the last `SETTLE_MS`) are left alone. A file is opened without
 *   following links, so one swapped for a link at the last moment is refused.
 * - Each file is filed as the folder's author, in the folder's scope; a
 *   writer who may no longer write there files nothing.
 * - The same content is filed once per folder (`scan_folder_files`), so a
 *   file that could not be moved aside is not filed again on every tick.
 * - A filed file is moved to `.octipus-done/<date>/` (or deleted); one that
 *   could not be filed goes to `.octipus-failed/`.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { ingestDocument, maxDocumentSize } from '@/core/documents/ingest';
import { getDb } from '@/db/postgres';
import { contentRepos } from '@/db/repositories/content';
import { type ScanFolder, scanFolderFiles, scanFolders } from '@/db/schema/scan-folders';
import { writerPrincipal } from '@/security/writer-principal';
import { coreLogger } from '@/utils/logger';

/** A file changed more recently than this is still being written. */
export const SETTLE_MS = 30_000;
/** Files one folder files per tick; the rest wait for the next. */
const FILES_PER_TICK = 50;
const FOLDERS_PER_TICK = 50;
export const DONE_DIR = '.octipus-done';
export const FAILED_DIR = '.octipus-failed';

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

/** Move `name` out of the folder into `sub` (a dated subfolder of it), never over another file. */
async function moveAside(folder: string, name: string, sub: string, now: Date): Promise<void> {
  const dir = join(folder, sub, now.toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const target = join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    try {
      await lstat(target);
    } catch {
      await rename(join(folder, name), target);
      return;
    }
  }
  throw new Error(`No free name for ${name} in ${sub}`);
}

/** Read a regular file without following a link, at most `max` bytes; null when it is not one or is too large. */
async function readRegular(path: string, max: number): Promise<Buffer | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** File what has settled in one folder now. Never throws: a failure is recorded on the folder. */
export async function scanFolder(folder: ScanFolder, now = new Date()): Promise<ScanResult> {
  const result: ScanResult = { filed: 0, failed: 0 };
  try {
    // The folder itself must still be the directory that was checked at save.
    const info = await lstat(folder.path);
    if (!info.isDirectory()) throw new Error('The folder is no longer a directory');
    const principal = await writerPrincipal(folder.userId, folder.workspaceId);
    if (!principal) throw new Error('The admin who set this folder up can no longer add documents here');
    const repos = contentRepos(principal);
    const max = maxDocumentSize();

    const entries = (await readdir(folder.path, { withFileTypes: true }))
      .filter((e) => e.isFile() && !isPending(e.name))
      .map((e) => e.name)
      .sort();
    let handled = 0;
    for (const name of entries) {
      if (handled >= FILES_PER_TICK) break;
      const path = join(folder.path, name);
      const st = await stat(path).catch(() => null);
      if (!st || now.getTime() - st.mtimeMs < SETTLE_MS) continue;
      handled++;
      let claimedId: string | null = null;
      let documentId: string | null = null;
      try {
        const buffer = await readRegular(path, max);
        if (!buffer) throw new Error(st.size > max ? 'The file is larger than the document limit' : 'Not a regular file');
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const [claimed] = await getDb()
          .insert(scanFolderFiles)
          .values({ folderId: folder.id, sha256, name: name.slice(0, 255) })
          .onConflictDoNothing()
          .returning({ id: scanFolderFiles.id });
        if (claimed) {
          claimedId = claimed.id;
          const doc = await ingestDocument(repos, {
            buffer,
            originalName: name,
            mimeType: mimeTypeOf(name),
            metadata: { source: 'scan_folder', scanFolderId: folder.id, scanFolder: folder.label },
          });
          documentId = doc.id;
          await getDb().update(scanFolderFiles).set({ documentId: doc.id }).where(eq(scanFolderFiles.id, claimed.id));
          if (doc.error) throw new Error(doc.error);
          result.filed++;
        }
        // Filed now or before (the same content): out of the folder.
        if (folder.afterFiling === 'delete') await unlink(path);
        else await moveAside(folder.path, name, DONE_DIR, now);
      } catch (err) {
        result.failed++;
        // Not filed: give the content back, so the file dropped in again is filed then.
        if (claimedId && !documentId) await getDb().delete(scanFolderFiles).where(eq(scanFolderFiles.id, claimedId)).catch(() => undefined);
        coreLogger.warn({ folderId: folder.id, err: (err as Error).message }, 'scan folder: a file could not be filed'); // no file name logged
        await moveAside(folder.path, name, FAILED_DIR, now).catch(() => undefined);
        result.error = `A file could not be filed: ${(err as Error).message}`.slice(0, 300);
      }
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

/** Folders scanned in this process right now. */
const running = new Set<string>();

/** The cron tick's sweep: every enabled folder, outside archived spaces. Returns how many files were filed. */
export async function scanDueFolders(now = new Date()): Promise<number> {
  const folders = await getDb()
    .select()
    .from(scanFolders)
    .where(and(
      eq(scanFolders.enabled, true),
      sql`NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${scanFolders.workspaceId} AND w.archived_at IS NOT NULL)`,
    ))
    .limit(FOLDERS_PER_TICK);
  let filed = 0;
  for (const folder of folders) {
    if (running.has(folder.id)) continue;
    running.add(folder.id);
    try {
      filed += (await scanFolder(folder, now)).filed;
    } finally {
      running.delete(folder.id);
    }
  }
  return filed;
}
