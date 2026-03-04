import { configSchema, type Config } from './schema';
import { defaultConfig } from './defaults';
import { logger } from '@/utils/logger';
import { getSettingsService } from './settings-service';
import { SETTINGS_REGISTRY, settingKeyToConfigPath } from './settings-registry';
import { loadBootstrapConfig } from './bootstrap-loader';
import { deepMerge } from './utils';

/**
 * Load runtime configuration from the settings service (DB + vault).
 * Merges: defaults → DB settings → bootstrap overrides for DB/Redis/security/api.
 * Call this after DB, Redis, vault, and settings service are initialized.
 */
export async function loadRuntimeConfig(
  setCache: (config: Config) => void,
): Promise<Config> {
  const bootstrap = loadBootstrapConfig();
  const svc = getSettingsService();

  // Build config from DB settings + defaults
  const runtimePartial: Record<string, any> = {};

  for (const def of SETTINGS_REGISTRY) {
    const value = svc.getSync(def.key);
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '' && def.defaultValue === '') continue;

    const path = settingKeyToConfigPath(def.key);
    let target = runtimePartial;
    for (let i = 0; i < path.length - 1; i++) {
      if (!target[path[i]]) target[path[i]] = {};
      target = target[path[i]];
    }
    target[path[path.length - 1]] = value;
  }

  // Derive voice enabled flags from paths
  if (runtimePartial.voice) {
    runtimePartial.voice.sttEnabled = !!runtimePartial.voice.whisperModelPath;
    runtimePartial.voice.ttsEnabled = !!runtimePartial.voice.piperModelPath;
  }

  // Build final config: defaults → DB runtime values → bootstrap (DB/Redis/security/api.host/api.port)
  const merged = deepMerge(
    deepMerge(defaultConfig, runtimePartial),
    {
      database: bootstrap.database,
      redis: bootstrap.redis,
      security: {
        ...runtimePartial.security,
        masterKey: bootstrap.security.masterKey,
        jwtSecret: bootstrap.security.jwtSecret,
        sessionSecret: bootstrap.security.sessionSecret,
      },
      api: {
        ...runtimePartial.api,
        host: bootstrap.api.host,
        port: bootstrap.api.port,
      },
    },
  );

  // Handle optional channel configs: only include if token/appId is set
  if (runtimePartial.telegram?.botToken) {
    merged.telegram = { ...defaultConfig.telegram, ...runtimePartial.telegram };
  } else {
    merged.telegram = undefined;
  }
  if (runtimePartial.slack?.botToken) {
    merged.slack = { ...defaultConfig.slack, ...runtimePartial.slack };
  } else {
    merged.slack = undefined;
  }
  if (runtimePartial.teams?.appId) {
    merged.teams = { ...defaultConfig.teams, ...runtimePartial.teams };
  } else {
    merged.teams = undefined;
  }
  if (runtimePartial.n8n?.url) {
    merged.n8n = { ...defaultConfig.n8n, ...runtimePartial.n8n };
  } else {
    merged.n8n = undefined;
  }

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    logger.error({ errors: result.error.errors }, 'Runtime configuration validation failed');
    throw new Error(`Runtime configuration validation failed: ${result.error.message}`);
  }

  setCache(result.data);
  logger.info('Runtime configuration loaded from database');

  return result.data;
}
