import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { GatewayEventBus } from '@/core/gateway/event-bus';
import { coreLogger } from '@/utils/logger';
import { buildExtensionContext } from './api';
import type { ExtensionFactory, LoadedExtension } from './types';

/**
 * Default discovery locations:
 *
 * - `~/.octipus/extensions/` — user-global
 * - `<cwd>/.octipus/extensions/` — project-local
 *
 * Each entry is either:
 * - a single `*.ts` file at the root → name = filename without extension
 * - a directory containing `index.ts` → name = directory name
 *
 * Files starting with `.` or `_` are skipped (private). Existing
 * `extensions/` plugin.json system is unaffected — it still loads via
 * `src/plugins/loader.ts`.
 */
export interface ExtensionDiscoveryOptions {
  cwd?: string;
  home?: string;
  /** Extra absolute dirs (used by tests / settings). */
  extraDirs?: string[];
}

interface DiscoveredEntry {
  name: string;
  entryPath: string;
}

function defaultDirs(cwd: string, home: string): string[] {
  return [
    join(home, '.octipus', 'extensions'),
    join(cwd, '.octipus', 'extensions'),
  ];
}

function discoverInDir(dir: string): DiscoveredEntry[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  const out: DiscoveredEntry[] = [];

  for (const name of entries) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }

    if (st.isFile() && extname(name) === '.ts') {
      out.push({ name: basename(name, '.ts'), entryPath: full });
    } else if (st.isDirectory()) {
      const idx = join(full, 'index.ts');
      if (existsSync(idx)) out.push({ name, entryPath: idx });
    }
  }

  return out;
}

export function discoverExtensions(opts: ExtensionDiscoveryOptions = {}): DiscoveredEntry[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const dirs = [...defaultDirs(cwd, home), ...(opts.extraDirs ?? []).map(d => resolve(d))];

  const seen = new Set<string>();
  const out: DiscoveredEntry[] = [];

  for (const dir of dirs) {
    for (const entry of discoverInDir(dir)) {
      // Project-local wins over user-global by virtue of order; first-seen wins.
      if (seen.has(entry.name)) {
        coreLogger.debug({ name: entry.name, dir }, 'extension already loaded by another dir, skipping');
        continue;
      }
      seen.add(entry.name);
      out.push(entry);
    }
  }

  return out;
}

/**
 * Import + invoke a single extension entry.
 *
 * Bun supports `await import(absPath)` for `.ts` files natively, no transpile
 * step. Failures are caught — one bad extension cannot block the others.
 *
 * Hot-reload caveat: Bun caches dynamic imports by resolved path and ignores
 * query strings, so editing an extension file in place and calling `/reload`
 * will NOT pick up the new module body until the host process restarts. The
 * `disposeAll → loadAll` flow correctly rediscovers files added or removed
 * since startup; in-place edits require a restart.
 */
export async function loadExtension(
  entry: DiscoveredEntry,
  eventBus: GatewayEventBus,
): Promise<LoadedExtension | undefined> {
  try {
    const mod = await import(entry.entryPath);
    const factory = (mod.default ?? mod) as ExtensionFactory;
    if (typeof factory !== 'function') {
      coreLogger.warn({ entry }, `extension "${entry.name}" has no default-exported function`);
      return undefined;
    }

    const { api, loaded } = buildExtensionContext(entry.name, entry.entryPath, eventBus);
    await factory(api);

    coreLogger.info({ name: entry.name, dir: dirname(entry.entryPath) }, 'extension loaded');
    return loaded;
  } catch (err) {
    coreLogger.error({ err, entry }, `failed to load extension "${entry.name}"`);
    return undefined;
  }
}
