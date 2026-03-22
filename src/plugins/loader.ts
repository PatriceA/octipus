import { resolve, join } from 'path';
import { readdir } from 'fs/promises';
import { createChildLogger } from '@/utils/logger';
import type { PluginManifest, PluginModule, LoadedPlugin, PluginContext } from './types';

const pluginLogger = createChildLogger({ component: 'plugin' });

/** In-memory store of all loaded plugins, keyed by manifest name */
const loadedPlugins: Map<string, LoadedPlugin> = new Map();

/**
 * Resolve the root extensions/ directory (project root)
 */
function getExtensionsDir(): string {
  // Walk up from src/plugins/ to project root, then into extensions/
  return resolve(import.meta.dir, '..', '..', 'extensions');
}

/**
 * Validate a parsed plugin.json object.
 * Throws if the manifest is invalid.
 */
function validateManifest(raw: unknown, dir: string): PluginManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid plugin.json in ${dir}: not an object`);
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error(`Invalid plugin.json in ${dir}: missing or empty "name"`);
  }
  if (typeof obj.version !== 'string' || !obj.version) {
    throw new Error(`Invalid plugin.json in ${dir}: missing or empty "version"`);
  }
  if (typeof obj.description !== 'string') {
    throw new Error(`Invalid plugin.json in ${dir}: missing "description"`);
  }
  if (typeof obj.main !== 'string' || !obj.main) {
    throw new Error(`Invalid plugin.json in ${dir}: missing or empty "main"`);
  }
  if (!Array.isArray(obj.tools)) {
    throw new Error(`Invalid plugin.json in ${dir}: "tools" must be an array`);
  }

  for (const tool of obj.tools) {
    if (typeof tool !== 'object' || !tool) {
      throw new Error(`Invalid plugin.json in ${dir}: each tool must be an object`);
    }
    if (typeof tool.name !== 'string' || !tool.name) {
      throw new Error(`Invalid plugin.json in ${dir}: tool missing "name"`);
    }
    if (typeof tool.description !== 'string') {
      throw new Error(`Invalid plugin.json in ${dir}: tool "${tool.name}" missing "description"`);
    }
    if (typeof tool.parameters !== 'object' || !tool.parameters) {
      throw new Error(`Invalid plugin.json in ${dir}: tool "${tool.name}" missing "parameters"`);
    }
  }

  return obj as unknown as PluginManifest;
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
        { name: plugin.manifest.name, version: plugin.manifest.version, tools: plugin.manifest.tools.length },
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
