/**
 * In-process plugins (docs/PLUGIN-PACKAGES.md#runtimes): installed plugin
 * packages with `runtime: "in-process"`, loaded into the server process as
 * trusted extensions (`octi.*`, docs/PLUGINS.md#from-an-extension-octihook-trusted-extensions-only).
 *
 * A plugin is loaded while its row is enabled and its in-process approval
 * covers its approved content (`inProcessApprovedHash === contentHash`), and
 * only after the check every package server start gets (`checkPackageBeforeStart`:
 * its files hash to the approved hash, its signature file is the approved
 * one, no revoked key, and a trusted signature under `plugins.requireSignature`).
 * Its module is imported from its installed directory (read in place, never
 * written) and its factory gets the same `octi` API a directory extension
 * gets (`buildExtensionContext`), trusted: it may hook the agent loop and
 * register tools and providers.
 *
 * `syncInProcessPlugins` (run by every change through `syncPluginServers`)
 * makes the loaded set match the rows: a plugin disabled, uninstalled,
 * upgraded or whose approval was cleared is disposed (every registration
 * undone, in reverse order), and one enabled and approved is loaded, without
 * a restart. Before the extension system has started (no event bus yet) it
 * does nothing; the boot calls it again once it has.
 *
 * Module caching: the entry module is imported under a query naming its
 * content hash, so new content loads new code. Modules it imports are cached
 * by the process under their own path; a plugin of several modules whose
 * imported files changed in an upgrade needs a restart (or a bundled entry).
 */
import { join } from 'node:path';
import { getDb } from '@/db/postgres';
import { pluginPackages, type PluginPackageRow } from '@/db/schema/plugin-packages';
import { buildExtensionContext } from '@/extensions/api';
import { peekExtensionRegistry } from '@/extensions/registry';
import type { ExtensionFactory, LoadedExtension } from '@/extensions/types';
import { pluginRuntime } from '@/shared/plugin-package';
import { importModuleAt } from '@/utils/import-module';
import { coreLogger } from '@/utils/logger';
import { checkPackageBeforeStart, inProcessApproved, packageDir } from './service';

interface LoadedPlugin {
  /** The content hash it was loaded with. */
  hash: string;
  extension: LoadedExtension;
}

/** Loaded plugins, in load order. */
const loaded = new Map<string, LoadedPlugin>();
/** Why a plugin that should be loaded is not. */
const problems = new Map<string, string>();
/** Syncs run one at a time, in the order asked. */
let queue: Promise<void> = Promise.resolve();

/** Whether an in-process plugin's module is loaded now. */
export function isInProcessLoaded(name: string): boolean {
  return loaded.has(name);
}

/** Why an enabled, approved in-process plugin is not loaded, or null. */
export function inProcessProblem(name: string): string | null {
  return problems.get(name) ?? null;
}

/** The names of the loaded in-process plugins, in load order. */
export function loadedInProcessPlugins(): string[] {
  return [...loaded.keys()];
}

function wanted(row: PluginPackageRow): boolean {
  return pluginRuntime(row.manifest) === 'in-process' && row.enabled && inProcessApproved(row);
}

/** Dispose one loaded plugin; a failing disposer is logged, never thrown. */
async function unload(name: string, reason: string): Promise<void> {
  const plugin = loaded.get(name);
  if (!plugin) return;
  loaded.delete(name);
  try {
    await plugin.extension.dispose();
  } catch (err) {
    coreLogger.warn({ err, pkg: name }, 'In-process plugin dispose threw');
  }
  coreLogger.info({ pkg: name, reason }, 'In-process plugin unloaded');
}

/** Check, import and run one plugin's factory; the problem, or null once loaded. */
async function load(row: PluginPackageRow): Promise<string | null> {
  const registry = peekExtensionRegistry();
  if (!registry) return null;
  const refused = await checkPackageBeforeStart(row.name);
  if (refused) return refused;
  const hash = row.contentHash as string;
  const entry = row.manifest.entry;
  if (!entry) return 'The manifest names no entry module';
  const entryPath = join(packageDir(row.name), entry);
  let factory: ExtensionFactory;
  try {
    const mod = await importModuleAt(entryPath, `content=${hash.slice('sha256:'.length)}`);
    factory = ((mod as { default?: unknown }).default ?? mod) as ExtensionFactory;
  } catch (err) {
    coreLogger.error({ err, pkg: row.name, entry }, 'In-process plugin module could not be imported');
    return `Could not import ${entry}: ${(err as Error).message}`;
  }
  if (typeof factory !== 'function') return `${entry} has no default-exported function (the extension factory)`;
  // Trusted: approved to run in the server process, for these bytes.
  const { api, loaded: extension } = buildExtensionContext(row.name, entryPath, registry.eventBus, true);
  try {
    await factory(api);
  } catch (err) {
    // What it registered before it threw is undone.
    await extension.dispose().catch(() => {});
    coreLogger.error({ err, pkg: row.name }, 'In-process plugin factory threw; unloaded');
    return `Its factory failed: ${(err as Error).message}`;
  }
  loaded.set(row.name, { hash, extension });
  coreLogger.info({ pkg: row.name, version: row.version, hash }, 'In-process plugin loaded');
  return null;
}

async function sync(): Promise<void> {
  if (!peekExtensionRegistry()) return;
  const rows = await getDb().select().from(pluginPackages);
  const want = new Map(rows.filter(wanted).map((r) => [r.name, r]));
  // Unload first, newest first: what is gone, disabled, unapproved or has other content now.
  for (const name of [...loaded.keys()].reverse()) {
    const row = want.get(name);
    if (!row) await unload(name, 'disabled, uninstalled or no longer approved');
    else if (row.contentHash !== loaded.get(name)?.hash) await unload(name, 'its approved content changed');
  }
  for (const name of [...problems.keys()]) if (!want.has(name)) problems.delete(name);
  for (const row of want.values()) {
    if (loaded.has(row.name)) continue;
    try {
      const problem = await load(row);
      if (problem) problems.set(row.name, problem);
      else problems.delete(row.name);
    } catch (err) {
      // One plugin that cannot load never stops the others, or the server.
      coreLogger.error({ err, pkg: row.name }, 'In-process plugin could not be loaded');
      problems.set(row.name, `Could not load: ${(err as Error).message}`);
    }
  }
}

/** Load and unload in-process plugins to match their rows (serialised). */
export function syncInProcessPlugins(): Promise<void> {
  const run = queue.then(sync, sync);
  queue = run.catch((err: unknown) => coreLogger.error({ err }, 'In-process plugins could not be synced'));
  return run;
}

/** Unload every in-process plugin, newest first (shutdown, tests). */
export function disposeInProcessPlugins(): Promise<void> {
  const run = queue.then(async () => {
    for (const name of [...loaded.keys()].reverse()) await unload(name, 'shutdown');
    problems.clear();
  });
  queue = run.catch(() => {});
  return run;
}
