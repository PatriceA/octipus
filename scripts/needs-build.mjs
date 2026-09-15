#!/usr/bin/env node
/**
 * Is dist/ older than the sources it was built from?
 *
 * `octi start` runs `node dist/index.js`, a build artifact that nothing
 * rebuilt, so after a `git pull` the backend went on serving the previous
 * checkout: healthy, answering every route, with the pulled change simply
 * absent. The CLIs call this before starting the backend.
 *
 * Exit 0 — dist/ is current, nothing to do.
 * Exit 1 — dist/ is missing or stale, rebuild.
 *
 * One implementation for both CLIs. The obvious shell equivalents are not
 * equivalent: `find -newer` is POSIX-only, and the PowerShell version of the
 * same question took over two minutes on Windows.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Build inputs that are not under src/. */
const EXTRA_INPUTS = ['package.json'];

/** Newest mtime under `dir`, stopping as soon as something beats `limit`. */
function anyNewerThan(dir, limit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (anyNewerThan(path, limit)) return true;
      continue;
    }
    if (statSync(path).mtimeMs > limit) return true;
  }
  return false;
}

function stale() {
  let built;
  try {
    built = statSync(join(root, 'dist', 'index.js')).mtimeMs;
  } catch {
    return true; // never built
  }
  for (const input of EXTRA_INPUTS) {
    try {
      if (statSync(join(root, input)).mtimeMs > built) return true;
    } catch { /* not present — not a build input then */ }
  }
  try {
    return anyNewerThan(join(root, 'src'), built);
  } catch {
    return false; // no src/ (a packaged install) — dist is all there is
  }
}

process.exitCode = stale() ? 1 : 0;
