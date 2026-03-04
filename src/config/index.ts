import { configSchema, type Config } from './schema';
import { defaultConfig } from './defaults';
import { logger } from '@/utils/logger';
import { getSettingsService } from './settings-service';
import { SETTINGS_REGISTRY, settingKeyToConfigPath } from './settings-registry';

let cachedConfig: Config | null = null;
let runtimeLoaded = false;

// ─── Bootstrap Config (env-only, used before DB is available) ───

export interface BootstrapConfig {
  database: Config['database'];
  redis: Config['redis'];
  security: {
    masterKey: string;
    jwtSecret: string;
    sessionSecret: string;
  };
  api: {
    host: string;
    port: number;
  };
}

/**
 * Load bootstrap configuration from environment variables.
 * Only reads the vars needed before DB/Redis are available.
 */
export function loadBootstrapConfig(): BootstrapConfig {
  return {
    database: {
      url: process.env.DATABASE_URL || defaultConfig.database!.url!,
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
      idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10),
    },
    redis: {
      url: process.env.REDIS_URL || defaultConfig.redis!.url!,
      keyPrefix: process.env.REDIS_KEY_PREFIX || defaultConfig.redis!.keyPrefix!,
      maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.REDIS_RETRY_DELAY || '1000', 10),
    },
    security: {
      masterKey: process.env.MASTER_KEY || '',
      jwtSecret: process.env.JWT_SECRET || '',
      sessionSecret: process.env.SESSION_SECRET || '',
    },
    api: {
      host: process.env.API_HOST || process.env.HOST || defaultConfig.api!.host!,
      port: parseInt(process.env.API_PORT || process.env.PORT || '3000', 10),
    },
  };
}

// ─── Legacy env loader (kept for migration from .env → DB) ───

/**
 * Load ALL config from environment variables (legacy behavior).
 * Used only during: (1) first boot before runtime config, (2) env-to-DB migration.
 */
export function loadFromEnvLegacy(): Partial<Config> {
  return {
    database: {
      url: process.env.DATABASE_URL || defaultConfig.database!.url!,
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
      idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10),
    },
    redis: {
      url: process.env.REDIS_URL || defaultConfig.redis!.url!,
      keyPrefix: process.env.REDIS_KEY_PREFIX || defaultConfig.redis!.keyPrefix!,
      maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.REDIS_RETRY_DELAY || '1000', 10),
    },
    litellm: {
      proxyUrl: process.env.LITELLM_URL || process.env.LITELLM_PROXY_URL || defaultConfig.litellm!.proxyUrl!,
      apiKey: process.env.LITELLM_API_KEY,
      timeout: parseInt(process.env.LITELLM_TIMEOUT || '120000', 10),
      maxRetries: parseInt(process.env.LITELLM_MAX_RETRIES || '3', 10),
    },
    ollama: {
      url: process.env.OLLAMA_URL || defaultConfig.ollama!.url!,
      defaultModel: process.env.OLLAMA_DEFAULT_MODEL || defaultConfig.ollama!.defaultModel!,
    },
    security: {
      masterKey: process.env.MASTER_KEY || '',
      jwtSecret: process.env.JWT_SECRET || '',
      sessionSecret: process.env.SESSION_SECRET || '',
      sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE || '86400000', 10),
      totpIssuer: process.env.TOTP_ISSUER || defaultConfig.security!.totpIssuer!,
      passkeyRpId: process.env.PASSKEY_RP_ID || defaultConfig.security!.passkeyRpId!,
      passkeyRpName: process.env.PASSKEY_RP_NAME || defaultConfig.security!.passkeyRpName!,
      passkeyOrigin: process.env.PASSKEY_ORIGIN || defaultConfig.security!.passkeyOrigin!,
    },
    api: {
      host: process.env.API_HOST || process.env.HOST || defaultConfig.api!.host!,
      port: parseInt(process.env.API_PORT || process.env.PORT || '3000', 10),
      corsOrigins: process.env.CORS_ORIGINS?.split(',') || defaultConfig.api!.corsOrigins!,
      rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10),
      rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    },
    telegram: process.env.TELEGRAM_BOT_TOKEN
      ? {
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          allowedUsers: process.env.TELEGRAM_ALLOWED_USERS?.split(',') || [],
          webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
          pollingTimeout: parseInt(process.env.TELEGRAM_POLLING_TIMEOUT || '30', 10),
        }
      : undefined,
    teams: process.env.TEAMS_APP_ID
      ? {
          appId: process.env.TEAMS_APP_ID,
          appPassword: process.env.TEAMS_APP_PASSWORD,
          tenantId: process.env.TEAMS_TENANT_ID,
        }
      : undefined,
    slack: process.env.SLACK_BOT_TOKEN
      ? {
          botToken: process.env.SLACK_BOT_TOKEN,
          appToken: process.env.SLACK_APP_TOKEN,
          signingSecret: process.env.SLACK_SIGNING_SECRET,
        }
      : undefined,
    voice: {
      sttEnabled: process.env.WHISPER_MODEL_PATH ? true : false,
      ttsEnabled: process.env.PIPER_MODEL_PATH ? true : false,
      whisperModelPath: process.env.WHISPER_MODEL_PATH,
      piperModelPath: process.env.PIPER_MODEL_PATH,
      wakeWord: process.env.WAKE_WORD,
      language: process.env.VOICE_LANGUAGE || 'en',
    },
    mcp: {
      serversConfigPath: process.env.MCP_SERVERS_CONFIG,
      autoStart: process.env.MCP_AUTO_START !== 'false',
      connectionTimeout: parseInt(process.env.MCP_CONNECTION_TIMEOUT || '30000', 10),
    },
    n8n: process.env.N8N_URL
      ? {
          url: process.env.N8N_URL,
          apiKey: process.env.N8N_API_KEY,
          webhookPath: process.env.N8N_WEBHOOK_PATH || '/n8n/webhook',
        }
      : undefined,
    logging: {
      level: (process.env.LOG_LEVEL as any) || defaultConfig.logging!.level,
      format: (process.env.LOG_FORMAT as any) || defaultConfig.logging!.format,
      file: process.env.LOG_FILE,
    },
    agent: {
      maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || '10', 10),
      defaultTimeout: parseInt(process.env.AGENT_DEFAULT_TIMEOUT || '300000', 10),
      maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || '50', 10),
      contextWindowSize: parseInt(process.env.CONTEXT_WINDOW_SIZE || '32000', 10),
      maxTokenBudget: parseInt(process.env.AGENT_MAX_TOKEN_BUDGET || '100000', 10),
    },
    orchestrator: {
      enabled: process.env.ORCHESTRATOR_ENABLED !== 'false',
      defaultModel: process.env.ORCHESTRATOR_MODEL || undefined,
      piiFilterEnabled: process.env.PII_FILTER_ENABLED !== 'false',
      maxPipelineStages: parseInt(process.env.MAX_PIPELINE_STAGES || '10', 10),
      approvalTimeoutMs: parseInt(process.env.APPROVAL_TIMEOUT_MS || '3600000', 10),
      workerTimeoutMs: parseInt(process.env.WORKER_TIMEOUT_MS || '600000', 10),
    },
    workspace: {
      rootPath: process.env.WORKSPACE_PATH || './workspace',
      additionalPaths: process.env.WORKSPACE_ADDITIONAL_PATHS?.split(',').filter(Boolean) || [],
    },
    oauth: {
      publicUrl: process.env.PUBLIC_URL,
    },
  };
}

// ─── Runtime Config (DB-backed, loaded after DB is available) ───

/**
 * Load runtime configuration from the settings service (DB + vault).
 * Merges: defaults → DB settings → bootstrap overrides for DB/Redis/security/api.
 * Call this after DB, Redis, vault, and settings service are initialized.
 */
export async function loadRuntimeConfig(): Promise<Config> {
  const bootstrap = loadBootstrapConfig();
  const svc = getSettingsService();

  // Build config from DB settings + defaults
  const runtimePartial: Record<string, any> = {};

  for (const def of SETTINGS_REGISTRY) {
    const value = svc.getSync(def.key);
    if (value === undefined || value === null) continue;

    // Skip empty strings for optional fields
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

  cachedConfig = result.data;
  runtimeLoaded = true;
  logger.info('Runtime configuration loaded from database');

  return cachedConfig;
}

/**
 * Update a single config key in the cached config object (hot-reload).
 * Called when settings change at runtime via pub/sub.
 */
export function refreshConfigKey(key: string, value: unknown): void {
  if (!cachedConfig) return;

  const path = settingKeyToConfigPath(key);
  if (path.length < 2) return;

  const section = path[0] as keyof Config;
  const field = path[1];

  // Don't allow hot-updating bootstrap fields
  const bootstrapFields = new Set(['database', 'redis']);
  if (bootstrapFields.has(section)) return;
  if (section === 'security' && ['masterKey', 'jwtSecret', 'sessionSecret'].includes(field)) return;
  if (section === 'api' && ['host', 'port'].includes(field)) return;

  // Update the cached config in place
  const sectionObj = cachedConfig[section];
  if (sectionObj && typeof sectionObj === 'object') {
    (sectionObj as any)[field] = value;
  } else if (value) {
    // Section didn't exist (e.g., telegram was undefined) — create it with defaults
    const def = defaultConfig[section];
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

/**
 * Check if runtime config has been loaded from DB
 */
export function isRuntimeConfigLoaded(): boolean {
  return runtimeLoaded;
}

// ─── Legacy loadConfig (backward compat during bootstrap) ───

/**
 * Load and validate configuration from env vars (legacy).
 * Used during bootstrap before runtime config is available.
 */
export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

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

/**
 * Get cached configuration (throws if not loaded)
 */
export function getConfig(): Config {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

/**
 * Reset cached configuration (for testing)
 */
export function resetConfig(): void {
  cachedConfig = null;
  runtimeLoaded = false;
}

/**
 * Deep merge two objects
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        target[key] !== null
      ) {
        result[key] = deepMerge(target[key], source[key] as any);
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

export * from './schema';
export { defaultConfig } from './defaults';
