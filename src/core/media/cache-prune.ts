/**
 * The model-ready copies of images (`.octipus/media/cache`, normalize.ts) are
 * a cache: a copy unused for 30 days is removed, once a day, in every
 * personal workspace and every space. The originals (uploads, generated
 * images, speech) are files of the workspace and are never touched; a pruned
 * copy is made again the next time the image is looked at.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MEDIA_CACHE_MAX_AGE_DAYS = 30;
const MAX_REMOVED_PER_RUN = 5_000;

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(path, d.name));
  } catch {
    return [];
  }
}

/** Every workspace's `files` root under the data root: users/*\/workspaces/*\/files and spaces/*\/files. */
async function workspaceRoots(dataRoot: string): Promise<string[]> {
  const roots: string[] = [];
  for (const user of await dirs(join(dataRoot, 'users'))) {
    for (const ws of await dirs(join(user, 'workspaces'))) roots.push(join(ws, 'files'));
  }
  for (const space of await dirs(join(dataRoot, 'spaces'))) roots.push(join(space, 'files'));
  return roots;
}

/** Remove cached copies not modified for `maxAgeDays`; returns how many. */
export async function pruneMediaCaches(dataRoot: string, now = new Date(), maxAgeDays = MEDIA_CACHE_MAX_AGE_DAYS): Promise<number> {
  const cutoff = now.getTime() - maxAgeDays * 24 * 3600_000;
  let removed = 0;
  for (const root of await workspaceRoots(dataRoot)) {
    const cache = join(root, '.octipus', 'media', 'cache');
    let names: string[];
    try { names = await readdir(cache); } catch { continue; }
    for (const name of names) {
      if (removed >= MAX_REMOVED_PER_RUN) return removed;
      // Only the cache's own files: <sha256>.png / .jpg.
      if (!/^[0-9a-f]{64}\.(png|jpg)$/.test(name)) continue;
      const file = join(cache, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile() && info.mtimeMs < cutoff) {
        await rm(file, { force: true });
        removed++;
      }
    }
  }
  return removed;
}
