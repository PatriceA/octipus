import { readdir } from 'fs/promises';
import { homedir } from 'os';
import { importModuleAt } from '@/utils/import-module';
import { join, resolve } from 'path';
import { checkApiVersion, manifestTools, validateManifest as validateManifestContract } from '@octipus/plugin-sdk';
import { createChildLogger } from '@/utils/logger';
import type { LoadedPlugin, PluginContext, PluginManifest, PluginModule } from './types';
import { fileAt } from '@/utils/fs-file';

const pluginLogger = createChildLogger({ component: 'plugin' });

/** In-memory store of all loaded plugins, keyed by manifest name */
const loadedPlugins: Map<string, LoadedPlugin> = new Map();

/**
 * Where legacy plugins are loaded from: `~/.octipus/legacy-plugins/`, next to
 * the in-process extensions (`~/.octipus/extensions/`) and outside any Octipus
 * checkout or install. A plugin someone makes stays on their machine; the
 * loader never reads plugins from the server's working directory.
 */
export function legacyPluginsDir(home: string = homedir()): string {
  return join(home, '.octipus', 'legacy-plugins');
}

/** Where legacy plugins used to load from, until they moved out of the checkout. */
const FORMER_DIR = 'extensions';

/** Warned once per process about plugins left in `<cwd>/extensions`. */
let formerDirWarned = false;

/**
 * `<cwd>/extensions` is no longer read. If it still holds plugin directories
 * (each with a `plugin.json`), say once which ones and where they go now.
 */
async function warnFormerDir(cwd: string, dir: string): Promise<void> {
  if (formerDirWarned) return;
  const former = resolve(cwd, FORMER_DIR);
  if (resolve(former) === resolve(dir)) return;
  let names: string[];
  try {
    names = (await readdir(former, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  const left: string[] = [];
  for (const name of names) {
    if (await fileAt(join(former, name, 'plugin.json')).exists()) left.push(name);
  }
  if (left.length === 0) return;
  formerDirWarned = true;
  pluginLogger.warn(
    { dir: former, plugins: left, newDir: dir },
    `Legacy plugins in ${former} are no longer loaded (${left.join(', ')}): plugins do not load from the Octipus checkout or the server's working directory. Move each one to ${dir}, or convert it to a plugin package with \`octi plugin convert ${join(former, '<name>')}\` (docs/PLUGINS.md#converting-to-a-plugin-package)`,
  );
}

/** Test hook: forget that the `<cwd>/extensions` warning was given. */
export function resetFormerDirWarningForTests(): void {
  formerDirWarned = false;
}

/**
 * Validate a parsed plugin.json against the published contract
 * (`@octipus/plugin-sdk`) and enforce apiVersion compatibility. Throws with a
 * clear, aggregated message when the manifest is invalid or the plugin targets
 * an incompatible contract version. A plugin with no `apiVersion` is loaded
 * with a deprecation warning (legacy), not refused.
 */
function validateManifest(raw: unknown, dir: string): PluginManifest {
  const result = validateManifestContract(raw);
  if (!result.ok) {
    throw new Error(`Invalid plugin.json in ${dir}: ${result.errors.join('; ')}`);
  }
  const manifest = result.manifest;

  const version = checkApiVersion(manifest.apiVersion);
  if (!version.ok) {
    throw new Error(`Plugin "${manifest.name}" in ${dir} refused: ${version.reason}`);
  }
  if (version.legacy) {
    pluginLogger.warn({ dir, plugin: manifest.name }, `Plugin has ${version.reason}`);
  }

  return manifest;
}

/** Plugins already warned about, so a reload does not repeat it. */
const deprecationWarned = new Set<string>();

/**
 * The legacy loader is deprecated in favour of plugin packages
 * (docs/PLUGIN-PACKAGES.md), which run out of process with declared effects.
 * Warn once per plugin and name the converter; loading is unchanged.
 */
function warnDeprecated(name: string, dir: string): void {
  if (deprecationWarned.has(name)) return;
  deprecationWarned.add(name);
  pluginLogger.warn(
    { dir, plugin: name },
    `Legacy in-process plugin "${name}" is deprecated: convert it to a plugin package with \`octi plugin convert ${dir}\` (docs/PLUGINS.md#converting-to-a-plugin-package)`,
  );
}

/**
 * Validate the module default export from a plugin entry file.
 */
function validateModule(mod: unknown, name: string): PluginModule {
  if (!mod || typeof mod !== 'object') {
    throw new Error(`Plugin "${name}" default export is not an object`);
  }

  const obj = mod as Record<string, unknown>;

  if (typeof obj.name !== 'string') {
    throw new Error(`Plugin "${name}" module missing "name" property`);
  }
  if (typeof obj.tools !== 'object' || !obj.tools) {
    throw new Error(`Plugin "${name}" module missing "tools" object`);
  }

  return obj as unknown as PluginModule;
}

/**
 * Load a single plugin from a directory.
 */
async function loadPlugin(dir: string, opts: { fresh?: boolean } = {}): Promise<LoadedPlugin> {
  const manifestPath = join(dir, 'plugin.json');

  // Read and parse manifest
  const manifestFile = fileAt(manifestPath);
  if (!(await manifestFile.exists())) {
    throw new Error(`No plugin.json found in ${dir}`);
  }

  const rawManifest = await manifestFile.json();
  const manifest = validateManifest(rawManifest, dir);
  warnDeprecated(manifest.name, dir);

  // Resolve and import the entry file
  const entryPath = join(dir, manifest.main);
  const entryFile = fileAt(entryPath);
  if (!(await entryFile.exists())) {
    throw new Error(`Plugin "${manifest.name}": entry file "${manifest.main}" not found in ${dir}`);
  }

  // A reload must not get Node's cached module back: ESM caches by URL, so the
  // same path returns the code that was loaded first, whatever is on disk now.
  // The query makes it a new URL. Modules the entry imports itself are not
  // re-evaluated, and every reload keeps its predecessor in memory — a
  // development aid, not something to run in a loop.
  const imported = await importModuleAt(entryPath, opts.fresh ? `reload=${Date.now()}` : undefined);
  const module = validateModule(imported.default ?? imported, manifest.name);

  return { manifest, module, directory: dir };
}

export interface LoadPluginsOptions {
  /** The directory to load from (default `~/.octipus/legacy-plugins`). */
  dir?: string;
  /** The working directory checked for plugins left in `<cwd>/extensions` (default `process.cwd()`). */
  cwd?: string;
}

/**
 * Scan the legacy plugin directory (`~/.octipus/legacy-plugins`) and load
 * all valid plugins. Returns the list of successfully loaded plugins.
 */
export async function loadPlugins(opts: LoadPluginsOptions = {}): Promise<LoadedPlugin[]> {
  const extensionsDir = resolve(opts.dir ?? legacyPluginsDir());
  await warnFormerDir(opts.cwd ?? process.cwd(), extensionsDir);

  let entries: string[];
  try {
    entries = (await readdir(extensionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    pluginLogger.debug({ dir: extensionsDir }, 'No legacy plugin directory found, skipping plugin loading');
    return [];
  }

  if (entries.length === 0) {
    pluginLogger.debug({ dir: extensionsDir }, 'No plugin directories found in the legacy plugin directory');
    return [];
  }

  const plugins: LoadedPlugin[] = [];

  for (const entry of entries) {
    const pluginDir = join(extensionsDir, entry);

    // Skip directories without plugin.json
    const manifestExists = await fileAt(join(pluginDir, 'plugin.json')).exists();
    if (!manifestExists) {
      pluginLogger.debug({ dir: entry }, 'Skipping directory without plugin.json');
      continue;
    }

    try {
      const plugin = await loadPlugin(pluginDir);

      // Build plugin context and call initialize()
      const context: PluginContext = {
        logger: createChildLogger({ component: 'plugin', plugin: plugin.manifest.name }),
        config: {},
      };

      if (plugin.module.initialize) {
        await plugin.module.initialize(context);
      }

      loadedPlugins.set(plugin.manifest.name, plugin);
      plugins.push(plugin);

      pluginLogger.info(
        { name: plugin.manifest.name, version: plugin.manifest.version, tools: manifestTools(plugin.manifest).length },
        'Plugin loaded',
      );
    } catch (err) {
      pluginLogger.error(
        { dir: entry, error: (err as Error).message },
        'Failed to load plugin',
      );
    }
  }

  pluginLogger.info({ count: plugins.length }, 'Plugin loading complete');
  return plugins;
}

/**
 * Get all currently loaded plugins.
 */
export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}

/**
 * Get a specific loaded plugin by name.
 */
export function getLoadedPlugin(name: string): LoadedPlugin | undefined {
  return loadedPlugins.get(name);
}

/** Why a reload was refused or failed; `status` is the HTTP answer for it. */
export class PluginReloadError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 500, readonly restored = false, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginReloadError';
  }
}

/** How the caller swaps the plugin's tool around a reload (the API's registry). */
export interface ReloadHooks {
  /** Take the running copy out of service; it must end with the module shut down. Default: its `shutdown`. */
  retire?: (previous: LoadedPlugin) => Promise<void>;
  /** Put the previous copy back in service after the new one failed to initialize. */
  restore?: (previous: LoadedPlugin) => Promise<void>;
}

/** Plugins with a reload in flight: a second one would retire a copy the first already retired. */
const reloading = new Set<string>();

function contextFor(plugin: LoadedPlugin): PluginContext {
  return { logger: createChildLogger({ component: 'plugin', plugin: plugin.manifest.name }), config: {} };
}

/**
 * Reload a single plugin by name.
 *
 *  1. Import and validate a fresh, cache-busted copy. A copy that does not
 *     parse or validate leaves the running one untouched.
 *  2. Retire the running copy (`hooks.retire`, else its `shutdown`), so a
 *     plugin that binds a port or takes a lock in `initialize` can do so again.
 *  3. Initialize the fresh copy. If that throws, the fresh copy is shut down
 *     (its partial resources released) and the previous one is initialized and
 *     restored; the error says whether that worked.
 *
 * The plugin map changes only once a copy is initialized, and each copy is
 * shut down at most once. Concurrent reloads of one plugin are refused.
 */
export async function reloadPlugin(name: string, hooks: ReloadHooks = {}): Promise<LoadedPlugin> {
  const existing = loadedPlugins.get(name);
  if (!existing) throw new PluginReloadError(`Plugin "${name}" is not loaded`, 404);
  if (reloading.has(name)) throw new PluginReloadError(`Plugin "${name}" is already being reloaded`, 409);
  reloading.add(name);
  try {
    let plugin: LoadedPlugin;
    try {
      plugin = await loadPlugin(existing.directory, { fresh: true });
    } catch (err) {
      throw new PluginReloadError(`Plugin "${name}" could not be loaded; the running copy is unchanged: ${(err as Error).message}`, 500, true, { cause: err });
    }
    if (plugin.manifest.name !== name) {
      throw new PluginReloadError(`Plugin in ${existing.directory} is now named "${plugin.manifest.name}", not "${name}"; restart to load it under its new name`, 409, true);
    }

    await (hooks.retire ? hooks.retire(existing) : existing.module.shutdown?.());

    try {
      await plugin.module.initialize?.(contextFor(plugin));
    } catch (err) {
      await plugin.module.shutdown?.().catch((e: unknown) => pluginLogger.warn({ err: e, plugin: name }, 'Failed plugin copy did not shut down cleanly'));
      let restored = false;
      try {
        await existing.module.initialize?.(contextFor(existing));
        await hooks.restore?.(existing);
        restored = true;
      } catch (restoreErr) {
        loadedPlugins.delete(name);
        pluginLogger.error({ err: restoreErr, plugin: name }, 'Previous plugin copy could not be restored; plugin unloaded');
      }
      throw new PluginReloadError(
        `Plugin "${name}" failed to initialize: ${(err as Error).message}. ${restored ? 'The previous copy was restored.' : 'The previous copy could not be restored; the plugin is unloaded.'}`,
        500, restored, { cause: err },
      );
    }

    loadedPlugins.set(name, plugin);
    pluginLogger.info({ name: plugin.manifest.name, version: plugin.manifest.version }, 'Plugin reloaded');
    return plugin;
  } finally {
    reloading.delete(name);
  }
}
