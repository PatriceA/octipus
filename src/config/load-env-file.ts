/**
 * Load `.env` into `process.env`.
 *
 * The previous runtime did this implicitly on every start, so nothing in the
 * codebase ever asked for it — which meant that on Node the migration runner,
 * the setup wizard and every script started with no `DATABASE_URL` and no
 * secrets, and failed config validation before doing anything. Node reads a
 * `.env` only when told to.
 *
 * Existing variables win, exactly as before: an explicit `DATABASE_URL=… npm
 * run …` overrides the file rather than being overridden by it.
 *
 * NOT under test. The previous runtime read the developer's `.env` there too,
 * which pointed a suite that deletes rows at whatever database that file names
 * — usually the real one. Tests get their values from `src/test-setup.ts` and
 * from whatever the runner is given explicitly, and nothing else.
 *
 * Imported for its side effect from `@/config`, which is the first thing every
 * entry point touches.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let loaded = false;

export function loadEnvFile(cwd: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  const path = process.env.ENV_FILE ?? join(cwd, '.env');
  if (!existsSync(path)) return;
  try {
    // `process.loadEnvFile` does not overwrite variables that are already set.
    process.loadEnvFile(path);
  } catch (err) {
    // A malformed `.env` must not be silent — config validation would then
    // blame a missing secret rather than the file that failed to parse.
    process.stderr.write(
      `[config] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

loadEnvFile();
