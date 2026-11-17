/** Validate and export declared companion artifacts. Never execute package code. */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { PluginManifest } from '@/shared/plugin-package';
import { readTarEntries } from './tar';
import { isPlainRelativePath } from './manifest-ui-host';

const unzip = promisify(gunzip);
export const MAX_COMPANION_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
export async function companionFile(dir: string, rel: string, limit: number): Promise<Buffer> {
  if (!isPlainRelativePath(rel)) throw new Error('Invalid companion path');
  // Every component is checked, not just the leaf; never follow a link.
  let current = dir;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('Companion file is not a regular package file: ' + rel);
    if (i === parts.length - 1 && info.size > limit) throw new Error('Companion file exceeds size limit: ' + rel);
  }
  const bytes = await readFile(current);
  if (bytes.length > limit) throw new Error('Companion file exceeds size limit: ' + rel);
  return bytes;
}

export async function companionFilesProblems(manifest: PluginManifest, dir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const c of manifest.companions ?? []) {
    try {
      await companionFile(dir, c.guide, 65536);
      const gz = await companionFile(dir, c.bundle, MAX_COMPANION_BUNDLE_BYTES);
      const tar = await unzip(gz, { maxOutputLength: MAX_EXPANDED_BYTES });
      const entries = readTarEntries(tar, { plainUstar: true });
      if (!entries.length || entries.length > 64) throw new Error('Bundle must contain 1–64 entries');
      const seen = new Set<string>();
      for (const entry of entries) {
        if (entry.path === null) continue;
        if (seen.has(entry.path)) throw new Error('Duplicate archive path: ' + entry.path);
        seen.add(entry.path);
      }
    } catch (err) { problems.push('companions.' + c.id + ': ' + (err as Error).message); }
  }
  return problems;
}
