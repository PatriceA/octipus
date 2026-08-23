import { logger } from '@/utils/logger';
import { loadBootstrapConfig } from './bootstrap-loader';
import { defaultConfig } from './defaults';
import { type Config, configSchema } from './schema';
import { SETTINGS_REGISTRY, settingKeyToConfigPath } from './settings-registry';
import { getSettingsService } from './settings-service';
import { deepMerge } from './utils';

// Lazy import to avoid circular dependency during module init
// (vault → audit-repository → getDb, but DB isn't ready at import time)
let _getVault: typeof import('@/security/vault').getVault | null = null;
async function lazyGetVault() {
  if (!_getVault) {
    const mod = await import('@/security/vault');
    _getVault = mod.getVault;
  }
  return _getVault();
}

/**
 * Load runtime configuration from the settings service (DB + vault).
 * Merges: defaults → DB settings → bootstrap overrides for DB/security/api.
 * Call this after the DB, vault, and settings service are initialized.
 */
export async function loadRuntimeConfig(
  setCache: (config: Config) => void,
): Promise<Config> {
  const bootstrap = loadBootstrapConfig();
  const svc = getSettingsService();

  // Build config from DB settings + defaults
  const runtimePartial: Record<string, any> = {};

  const vault = await lazyGetVault();

  for (const def of SETTINGS_REGISTRY) {
    let value = svc.getSync(def.key);

    // For secrets stored in vault, resolve the actual secret value
    if (def.isSecret && def.vaultName) {
      try {
        const secret = await vault.getSystemSecret(def.vaultName);
        if (secret) {
          value = secret;
        } else {
          value = undefined; // Not in vault — fall through to env var
        }
      } catch {
        value = undefined; // Vault error — fall through to env var
      }
    }

    // If not in DB/vault (or empty default), fall back to env var
    if ((value === undefined || value === null || (typeof value === 'string' && value === '' && def.defaultValue === '')) && def.envVar) {
      const envVal = process.env[def.envVar];
      if (envVal !== undefined && envVal !== '') {
        value = def.valueType === 'number' ? Number(envVal)
          : def.valueType === 'boolean' ? envVal !== 'false'
          : def.valueType === 'string_array' ? envVal.split(',').map(s => s.trim()).filter(Boolean)
          : envVal;
      }
    }

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
    // Only piper needs a local model file; every other engine is remote/CLI.
    runtimePartial.voice.ttsEnabled =
      !!runtimePartial.voice.piperModelPath ||
      (!!runtimePartial.voice.ttsProvider && runtimePartial.voice.ttsProvider !== 'piper');
  }

  // Build final config: defaults → DB runtime values → bootstrap (DB/security/api.host/api.port)
  const merged = deepMerge(
    deepMerge(defaultConfig, runtimePartial),
    {
      database: bootstrap.database,
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
    logger.error({ errors: result.error.issues }, 'Runtime configuration validation failed');
    throw new Error(`Runtime configuration validation failed: ${result.error.message}`);
  }

  setCache(result.data);
  logger.info('Runtime configuration loaded from database');

  return result.data;
}
