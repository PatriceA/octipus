import { existsSync, readdirSync, statSync } from 'node:fs';
import { importModuleAt } from '@/utils/import-module';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { GatewayEventBus } from '@/core/gateway/event-bus';
import { coreLogger } from '@/utils/logger';
import { buildExtensionContext, isTrustedExtension } from './api';
import type { ExtensionFactory, LoadedExtension } from './types';

/**
 * Default discovery location: `~/.octipus/extensions/` (per user, outside any
 * checkout). There is no project-local discovery: a cloned repository's
 * `.octipus/extensions` is never loaded, so a checkout cannot bring code into
 * the server by being the working directory.
 *
 * Each entry is either:
 * - a single `*.ts` file at the root → name = filename without extension
 * - a directory containing `index.ts` → name = directory name
 *
 * Files starting with `.` or `_` are skipped (private). Legacy `plugin.json`
 * plugins load separately, from `~/.octipus/legacy-plugins/`
 * (`src/plugins/loader.ts`).
 */
export interface ExtensionDiscoveryOptions {
  /** Used only to warn about a leftover `<cwd>/.octipus/extensions`; never loaded. */
  cwd?: string;
  home?: string;
  /** Extra absolute dirs (used by tests / settings). */
  extraDirs?: string[];
}

interface DiscoveredEntry {
  name: string;
  entryPath: string;
}

function defaultDirs(home: string): string[] {
  return [join(home, '.octipus', 'extensions')];
}

/** Warned once per process about a project-local directory that is no longer read. */
let projectLocalWarned = false;

/** Test hook: forget that the project-local warning was given. */
export function resetProjectLocalWarningForTests(): void {
  projectLocalWarned = false;
}

function warnProjectLocal(cwd: string, home: string): void {
  if (projectLocalWarned) return;
  const dir = join(cwd, '.octipus', 'extensions');
  const userDir = join(home, '.octipus', 'extensions');
  if (resolve(dir) === resolve(userDir)) return;
  const names = discoverInDir(dir).map((e) => e.name);
  if (names.length === 0) return;
  projectLocalWarned = true;
  coreLogger.warn(
    { dir, extensions: names, userDir },
    `Project-local extensions in ${dir} are not loaded (${names.join(', ')}): extensions load only from ${userDir}. Move the ones you trust there.`,
  );
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
  warnProjectLocal(cwd, home);
  const dirs = [...defaultDirs(home), ...(opts.extraDirs ?? []).map(d => resolve(d))];

  const seen = new Set<string>();
  const out: DiscoveredEntry[] = [];

  for (const dir of dirs) {
    for (const entry of discoverInDir(dir)) {
      // The user directory comes first; first-seen wins.
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
    // Cache-bust the dynamic import so an in-place edit + /reload actually
    // re-evaluates the file body. Bun keeps a per-resolved-path cache that
    // ignores query strings on disk paths, so we use a file:// URL with a
    // mtime/now-stamped query. If this still doesn't bust the cache, the
    // restart is still needed — but for the common case it gives users the
    // hot-reload they expect.
    // Trust is decided here, before the module's code runs: decided inside
    // its factory, the extension could have arranged to pass.
    const trusted = isTrustedExtension(entry.entryPath);
    let mod: unknown;
    try {
      mod = await importModuleAt(entry.entryPath, `v=${Date.now()}`);
    } catch {
      // Fall back to the bare path — some loaders reject query strings on
      // local paths.
      mod = await importModuleAt(entry.entryPath);
    }
    const factory = ((mod as { default?: unknown }).default ?? mod) as ExtensionFactory;
    if (typeof factory !== 'function') {
      coreLogger.warn({ entry }, `extension "${entry.name}" has no default-exported function`);
      return undefined;
    }

    const { api, loaded } = buildExtensionContext(entry.name, entry.entryPath, eventBus, trusted);
    try {
      await factory(api);
    } catch (err) {
      // What the factory registered before it threw would otherwise stay
      // registered (and be added again on every /reload).
      await loaded.dispose().catch(() => {});
      throw err;
    }

    coreLogger.info({ name: entry.name, dir: dirname(entry.entryPath) }, 'extension loaded');
    return loaded;
  } catch (err) {
    coreLogger.error({ err, entry }, `failed to load extension "${entry.name}"`);
    return undefined;
  }
}
