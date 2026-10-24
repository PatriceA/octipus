#!/usr/bin/env node
/**
 * Are a package's installed dependencies older than its lockfile?
 *
 *   node scripts/needs-install.mjs [root|web|mcp-server]   (default: root)
 *
 * `octi start` rebuilds the backend when its sources changed (needs-build.mjs),
 * but nothing installed the dependencies a `git pull` brought: the new build
 * then failed to boot on a missing package (`ERR_MODULE_NOT_FOUND`), and the
 * supervisor went on serving the last good build, healthy and a version
 * behind. npm records each install in `node_modules/.package-lock.json`; a
 * lockfile newer than that record means the tree on disk is not the locked one.
 *
 * Exit 0 — installed dependencies match the lockfile (or there is no lockfile).
 * Exit 1 — not installed, or the lockfile changed since: run `npm ci`.
 */
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDERS = { root: '.', web: 'web', 'mcp-server': 'mcp-server' };

export function needsInstall(dir) {
  let locked;
  try {
    locked = statSync(join(dir, 'package-lock.json')).mtimeMs;
  } catch {
    return false; // no lockfile: nothing to install from
  }
  try {
    return statSync(join(dir, 'node_modules', '.package-lock.json')).mtimeMs < locked;
  } catch {
    return true; // never installed
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2] ?? 'root';
  const folder = FOLDERS[name];
  if (folder === undefined) {
    process.stderr.write(`needs-install: unknown package "${name}" (expected ${Object.keys(FOLDERS).join(', ')})\n`);
    process.exit(2);
  }
  process.exitCode = needsInstall(resolve(root, folder)) ? 1 : 0;
}
