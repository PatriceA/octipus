/**
 * The running Octipus version, read from the package that ships it.
 *
 * `package.json` is the single declaration; every other file that carries the
 * version (the web app, the Tauri bundle, the MCP package, the plugin SDK) is
 * rewritten from it by `scripts/sync-version.ts` on a release tag.
 *
 * Resolved relative to THIS module rather than the working directory. The
 * `/version` command used to read `process.cwd()/package.json`, which is the
 * version of whatever project the operator happened to be standing in — and in
 * a bundled `dist/index.js` started from anywhere else, no version at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import { octipusRoot } from '@/utils/install-root';

let cached: string | null = null;

export function getAppVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(join(octipusRoot(), 'package.json'), 'utf-8')) as { version?: string };
    cached = pkg.version || '0.0.0';
  } catch (err) {
    logger.warn({ err }, 'Could not read the Octipus version from package.json');
    cached = '0.0.0';
  }
  return cached;
}
