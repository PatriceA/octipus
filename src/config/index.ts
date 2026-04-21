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

  const sectionObj = cachedConfig[section];
  if (sectionObj && typeof sectionObj === 'object') {
    (sectionObj as any)[field] = value;
  } else if (value) {
    const def = defaultConfig[section] as Record<string, unknown> | undefined;
    (cachedConfig as any)[section] = { ...def, [field]: value };
  }

  // Handle derived fields
  if (key === 'voice.whisperModelPath') {
    cachedConfig.voice.sttEnabled = !!value;
  } else if (key === 'voice.piperModelPath') {
    cachedConfig.voice.ttsEnabled = !!value;
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
    logger.error({ errors: result.error.errors }, 'Configuration validation failed');
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
