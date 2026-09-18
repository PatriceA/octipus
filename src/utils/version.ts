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
import { dirname, join } from 'node:path';

let cached: string | null = null;

export function getAppVersion(): string {
  if (cached) return cached;
  // dist/index.js → repo root; src/utils/version.ts → src/utils, ../.. → root.
  const here = import.meta.dirname;
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json'), join(dirname(here), 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
      // Guard against picking up a dependency's or a workspace's package.json.
      if (pkg.name === 'octipus' && pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // Next candidate.
    }
  }
  cached = '0.0.0';
  return cached;
}
