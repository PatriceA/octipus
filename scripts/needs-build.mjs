#!/usr/bin/env node
/**
 * Is a build output older than the sources it was built from?
 *
 *   node scripts/needs-build.mjs [backend|mcp-server|web]   (default: backend)
 *
 * `octi start` runs `node dist/index.js`, a build artifact that nothing
 * rebuilt, so after a `git pull` the backend went on serving the previous
 * checkout: healthy, answering every route, with the pulled change simply
 * absent. The CLIs call this before starting the backend, and `octi start`
 * asks it about the MCP server and the web bundle too, which it used to
 * rebuild on every start whether anything had changed or not.
 *
 * Exit 0 — the output is current, nothing to do.
 * Exit 1 — the output is missing or stale, rebuild.
 *
 * One implementation for both CLIs. The obvious shell equivalents are not
 * equivalent: `find -newer` is POSIX-only, and the PowerShell version of the
 * same question took over two minutes on Windows.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Per target: the file its build writes, the directories it reads, the single
 * files it reads, and directory names inside those that are not inputs.
 */
const TARGETS = {
  backend: { output: 'dist/index.js', dirs: ['src'], files: ['package.json'], skip: [] },
  'mcp-server': {
    output: 'mcp-server/dist/index.js',
    dirs: ['mcp-server/src'],
    files: ['mcp-server/package.json', 'mcp-server/tsconfig.json'],
    skip: [],
  },
  // The web app imports from the backend's src/ (shared types, protocol,
  // task helpers), so any of it counts. index.html is the last file Vite
  // writes. OCTIPUS_WEB_DIST_DIR is the same override vite.config.ts and
  // serve.mjs read.
  web: {
    output: join('web', process.env.OCTIPUS_WEB_DIST_DIR || 'dist', 'index.html'),
    dirs: ['web', 'src'],
    files: [],
    skip: ['node_modules', 'dist', 'out', 'src-tauri', 'test-results', 'playwright-report'],
  },
};

/** Is anything under `dir` newer than `limit`? Stops at the first that is. */
function anyNewerThan(dir, limit, skip) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // By name, whatever the entry is: node_modules may be a symlink.
    if (skip.includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (anyNewerThan(path, limit, skip)) return true;
      continue;
    }
    // Written by `tsc` type checks, not read by the build.
    if (entry.name.endsWith('.tsbuildinfo')) continue;
    if (statSync(path).mtimeMs > limit) return true;
  }
  return false;
}

function stale(target) {
  let built;
  try {
    built = statSync(resolve(root, target.output)).mtimeMs;
  } catch {
    return true; // never built
  }
  for (const input of target.files) {
    try {
      if (statSync(join(root, input)).mtimeMs > built) return true;
    } catch { /* not present — not a build input then */ }
  }
  for (const dir of target.dirs) {
    try {
      if (anyNewerThan(join(root, dir), built, target.skip)) return true;
    } catch (err) {
      // No sources (a packaged install): the output is all there is. Anything
      // else, a dangling link among them say, rebuilds rather than guesses.
      if (err?.code === 'ENOENT' && err.path === join(root, dir)) continue;
      process.stderr.write(`needs-build: ${err?.message ?? err} — rebuilding\n`);
      return true;
    }
  }
  return false;
}

const name = process.argv[2] ?? 'backend';
const target = TARGETS[name];
if (!target) {
  process.stderr.write(`needs-build: unknown target "${name}" (expected ${Object.keys(TARGETS).join(', ')})\n`);
  process.exit(2);
}
process.exitCode = stale(target) ? 1 : 0;
