import { readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { checkApiVersion, manifestTools, validateManifest as validateManifestContract } from '@octipus/plugin-sdk';
import { createChildLogger } from '@/utils/logger';
import type { LoadedPlugin, PluginContext, PluginManifest, PluginModule } from './types';

const pluginLogger = createChildLogger({ component: 'plugin' });

/** In-memory store of all loaded plugins, keyed by manifest name */
const loadedPlugins: Map<string, LoadedPlugin> = new Map();

/**
 * Resolve the root extensions/ directory (project root)
 */
function getExtensionsDir(): string {
  return resolve(process.cwd(), 'extensions');
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
async function loadPlugin(dir: string): Promise<LoadedPlugin> {
  const manifestPath = join(dir, 'plugin.json');

  // Read and parse manifest
  const manifestFile = Bun.file(manifestPath);
  if (!(await manifestFile.exists())) {
    throw new Error(`No plugin.json found in ${dir}`);
  }

  const rawManifest = await manifestFile.json();
  const manifest = validateManifest(rawManifest, dir);

  // Resolve and import the entry file
  const entryPath = join(dir, manifest.main);
  const entryFile = Bun.file(entryPath);
  if (!(await entryFile.exists())) {
    throw new Error(`Plugin "${manifest.name}": entry file "${manifest.main}" not found in ${dir}`);
  }

  const imported = await import(entryPath);
  const module = validateModule(imported.default ?? imported, manifest.name);

  return { manifest, module, directory: dir };
}

/**
 * Scan the extensions/ directory and load all valid plugins.
 * Returns the list of successfully loaded plugins.
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  const extensionsDir = getExtensionsDir();

  // Check if extensions/ directory exists
  let entries: string[];
  try {
    entries = (await readdir(extensionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    pluginLogger.debug('No extensions/ directory found, skipping plugin loading');
    return [];
  }

  if (entries.length === 0) {
    pluginLogger.debug('No plugin directories found in extensions/');
    return [];
  }

  const plugins: LoadedPlugin[] = [];

  for (const entry of entries) {
    const pluginDir = join(extensionsDir, entry);

    // Skip directories without plugin.json
    const manifestExists = await Bun.file(join(pluginDir, 'plugin.json')).exists();
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

/**
 * Reload a single plugin by name.
 * Unregisters the old plugin tool, re-imports the entry file, and re-registers.
 * Returns the newly loaded plugin.
 */
export async function reloadPlugin(name: string): Promise<LoadedPlugin> {
  const existing = loadedPlugins.get(name);
  if (!existing) {
    throw new Error(`Plugin "${name}" is not loaded`);
  }

  // Call shutdown on old module
  if (existing.module.shutdown) {
    await existing.module.shutdown();
  }

  // Remove from cache
  loadedPlugins.delete(name);

  // Re-load from the same directory
  const plugin = await loadPlugin(existing.directory);

  // Initialize
  const context: PluginContext = {
    logger: createChildLogger({ component: 'plugin', plugin: plugin.manifest.name }),
    config: {},
  };

  if (plugin.module.initialize) {
    await plugin.module.initialize(context);
  }

  loadedPlugins.set(plugin.manifest.name, plugin);

  pluginLogger.info(
    { name: plugin.manifest.name, version: plugin.manifest.version },
    'Plugin reloaded',
  );

  return plugin;
}
