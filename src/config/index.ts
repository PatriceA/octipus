import { logger } from '@/utils/logger';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { loadRuntimeConfig as loadRuntimeConfigImpl } from './runtime-loader';
import { type Config, configSchema } from './schema';
import { settingKeyToConfigPath } from './settings-registry';
import { deepMerge } from './utils';

let cachedConfig: Config | null = null;
let runtimeLoaded = false;

// ─── Runtime Config ────────────────────────────────────────────

export async function loadRuntimeConfig(): Promise<Config> {
  const config = await loadRuntimeConfigImpl((c) => {
    cachedConfig = c;
    runtimeLoaded = true;
  });
  return config;
}

export function isRuntimeConfigLoaded(): boolean {
  return runtimeLoaded;
}

// ─── Hot-reload support ────────────────────────────────────────

/**
 * Does this settings path walk into an object's prototype?
 *
 * A settings ROW supplies the key, so the path is data, not a literal, and
 * `swarm.__proto__.polluted` would otherwise assign onto `Object.prototype` —
 * handing every plain object in the process a new property. The whole update is
 * refused rather than sanitised: a key containing one of these names is not a
 * setting anyone meant to change.
 */
export function isPrototypePath(path: string[]): boolean {
  return path.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype');
}

export function refreshConfigKey(key: string, value: unknown): void {
  if (!cachedConfig) return;

  const path = settingKeyToConfigPath(key);
  if (path.length < 2) return;

  const section = path[0] as keyof Config;
  const field = path[1];

  // Don't allow hot-updating bootstrap fields
  const bootstrapFields = new Set(['database', 'redis', 'storageMode']);
  if (bootstrapFields.has(section)) return;
  if (section === 'security' && ['masterKey', 'jwtSecret', 'sessionSecret'].includes(field)) return;
  if (section === 'api' && ['host', 'port'].includes(field)) return;

  // Walk the full dot-path and set the leaf. Handles deep keys like
  // `swarm.levelDefaults.agent.wallMs` — the old 2-level implementation
  // overwrote `swarm.levelDefaults` with a scalar, silently wiping the
  // structure and leaving workers on the hardcoded defaults.
  if (!cachedConfig[section] || typeof cachedConfig[section] !== 'object') {
    const def = defaultConfig[section] as Record<string, unknown> | undefined;
    (cachedConfig as any)[section] = def ? { ...def } : {};
  }
  if (isPrototypePath(path)) {
    logger.warn({ key }, 'Config refresh refused — key walks a prototype chain');
    return;
  }

  let target: Record<string, unknown> = cachedConfig[section] as Record<string, unknown>;
  for (let i = 1; i < path.length - 1; i++) {
    const key = path[i];
    if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object') {
      target[key] = {};
    }
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1]] = value;

  // Handle derived fields
  if (key === 'voice.whisperModelPath') {
    cachedConfig.voice.sttEnabled = !!value;
  } else if (key === 'voice.piperModelPath' || key === 'voice.ttsProvider') {
    // Only piper needs a local model file; every other engine is remote/CLI.
    cachedConfig.voice.ttsEnabled =
      !!cachedConfig.voice.piperModelPath || cachedConfig.voice.ttsProvider !== 'piper';
  }

  logger.debug({ key }, 'Config key refreshed');
}

// ─── Legacy loadConfig (env-based, used during bootstrap) ──────

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const envConfig = loadFromEnvLegacy();
  const merged = deepMerge(defaultConfig, envConfig);
  const result = configSchema.safeParse(merged);

  if (!result.success) {
    logger.error({ errors: result.error.issues }, 'Configuration validation failed');
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }

  cachedConfig = result.data;
  logger.info('Configuration loaded successfully');
  return cachedConfig;
}

export function getConfig(): Config {
  if (!cachedConfig) return loadConfig();
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
  runtimeLoaded = false;
}

// ─── Re-exports ────────────────────────────────────────────────

export { type BootstrapConfig, loadBootstrapConfig } from './bootstrap-loader';
export { defaultConfig } from './defaults';
export { loadFromEnvLegacy } from './legacy-loader';
export * from './schema';
