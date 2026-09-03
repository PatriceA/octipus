import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from './defaults';
import type { Config } from './schema';

// Absolute workspace root (see defaults.ts — `~` is not expanded by resolve()).
const WORKSPACE_ROOT = join(homedir(), '.octipus', 'workspace');

/**
 * First env var that is set, by name. Used where a setting was renamed: the
 * new name wins, the retired one still works, and an install that never
 * touched its .env keeps the value it had.
 */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Load ALL config from environment variables (legacy behavior).
 * Used only during: (1) first boot before runtime config, (2) env-to-DB migration.
 */
export function loadFromEnvLegacy(): Partial<Config> {
  return {
    storageMode: (process.env.STORAGE_MODE as 'embedded' | 'external') || 'external',
    database: {
      url: process.env.DATABASE_URL || defaultConfig.database!.url!,
      dataDir: process.env.DATA_DIR || defaultConfig.database?.dataDir || '~/.octipus/data',
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
      idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10),
    },
    litellm: {
      proxyUrl: process.env.LITELLM_URL || process.env.LITELLM_PROXY_URL || defaultConfig.litellm!.proxyUrl!,
      apiKey: process.env.LITELLM_API_KEY,
      timeout: parseInt(process.env.LITELLM_TIMEOUT || '120000', 10),
      maxRetries: parseInt(process.env.LITELLM_MAX_RETRIES || '3', 10),
    },
    ollama: {
      url: process.env.OLLAMA_URL || undefined,
      defaultModel: process.env.OLLAMA_DEFAULT_MODEL || defaultConfig.ollama!.defaultModel!,
      requestTimeout: parseInt(process.env.OLLAMA_REQUEST_TIMEOUT || '300000', 10),
      keepAlive: process.env.OLLAMA_KEEP_ALIVE || '10m',
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
      shellSandbox: ((): 'off' | 'auto' | 'required' => {
        const v = process.env.SHELL_SANDBOX;
        if (v === 'auto' || v === 'required') return v;
        return 'off';
      })(),
      vaultDenyUnscopedSecrets: process.env.VAULT_DENY_UNSCOPED_SECRETS === 'true',
      dockerIsolation: process.env.DOCKER_ISOLATION === 'enforce' ? 'enforce' : 'off',
    },
    api: {
      host: process.env.API_HOST || process.env.HOST || defaultConfig.api!.host!,
      port: parseInt(process.env.API_PORT || process.env.PORT || '3000', 10),
      corsOrigins: process.env.CORS_ORIGINS?.split(',') || defaultConfig.api!.corsOrigins!,
      rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '600', 10),
    },
    telegram: process.env.TELEGRAM_BOT_TOKEN
      ? {
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          allowedUsers: process.env.TELEGRAM_ALLOWED_USERS?.split(',') || [],
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
      // Env is a first-boot seed only; ttsProvider is chosen in settings (DB).
      // Default is cloud (mistral) so voice-out works without a piper binary,
      // which makes ttsEnabled true by default (a non-piper provider is set).
      ttsEnabled: true,
      sttProvider: 'auto' as const,
      fasterWhisperModel: 'small' as const,
      ttsProvider: 'mistral' as const,
      whisperModelPath: process.env.WHISPER_MODEL_PATH,
      piperModelPath: process.env.PIPER_MODEL_PATH,
      wakeWord: process.env.WAKE_WORD,
      language: process.env.VOICE_LANGUAGE || 'en',
    },
    mcp: {
      serversConfigPath: process.env.MCP_SERVERS_CONFIG,
      autoStart: process.env.MCP_AUTO_START !== 'false',
    },
    n8n: process.env.N8N_URL
      ? {
          url: process.env.N8N_URL,
          apiKey: process.env.N8N_API_KEY,
        }
      : undefined,
    logging: {
      level: (process.env.LOG_LEVEL as any) || defaultConfig.logging!.level,
      format: (process.env.LOG_FORMAT as any) || defaultConfig.logging!.format,
    },
    agent: {
      maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || '10', 10),
      defaultTimeout: parseInt(process.env.AGENT_DEFAULT_TIMEOUT || '900000', 10),
      maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || '50', 10),
      contextWindowSize: parseInt(process.env.CONTEXT_WINDOW_SIZE || '32000', 10),
      maxTokenBudget: parseInt(process.env.AGENT_MAX_TOKEN_BUDGET || '100000', 10),
      // The `ORCHESTRATOR_*` names are still read as a fallback: they are set
      // in real .env files, and dropping them would silently reset a tuned
      // install to defaults rather than fail loudly.
      promptTier: (env('AGENT_PROMPT_TIER', 'ORCHESTRATOR_MODE') as 'auto' | 'full' | 'lite') || 'auto',
      liteMaxIterations: parseInt(env('AGENT_LITE_MAX_ITERATIONS', 'ORCHESTRATOR_LITE_MAX_ITERATIONS') || '8', 10),
      smallModelMaxParams: parseInt(env('AGENT_SMALL_MODEL_MAX_PARAMS', 'ORCHESTRATOR_ROUTER_MAX_PARAMS') || '10000000000', 10),
      liteModelMaxParams: parseInt(env('AGENT_LITE_MAX_PARAMS', 'ORCHESTRATOR_LITE_MAX_PARAMS') || '24000000000', 10),
      smallModelMaxTools: parseInt(env('AGENT_SMALL_MODEL_MAX_TOOLS', 'ORCHESTRATOR_SMALL_MODEL_MAX_TOOLS') || '7', 10),
      pipelineTokenBudget: parseInt(process.env.PIPELINE_TOKEN_BUDGET || '2000000', 10),
      lazyToolDiscovery: env('AGENT_LAZY_TOOLS', 'ORCHESTRATOR_LAZY_TOOLS') !== 'false',
      turnTimeoutMs: parseInt(env('AGENT_TURN_TIMEOUT_MS', 'ORCHESTRATOR_TIMEOUT_MS') || '1800000', 10),
      hookTurnTimeoutMs: parseInt(env('AGENT_HOOK_TURN_TIMEOUT_MS', 'ORCHESTRATOR_HOOK_TIMEOUT_MS') || '2700000', 10),
    },
    multiuser: {
      // No `enabled` flag — Octipus is always multi-user. These sub-flags
      // tune independent layered features; enforcePermissions is
      // secure-by-default (opt out with MULTIUSER_ENFORCE_PERMISSIONS=false).
      auditShadow: process.env.MULTIUSER_AUDIT_SHADOW !== 'false',
      enforcePermissions: process.env.MULTIUSER_ENFORCE_PERMISSIONS !== 'false',
      rlsEnabled: process.env.MULTIUSER_RLS === 'true',
      orgWorkspaces: process.env.MULTIUSER_ORG_WORKSPACES === 'true',
      // Falls back to the shipped default EXPLICITLY when the variable is
      // unset. The previous `(process.env.X || '').split(',')` produced `[]`
      // for an unset variable, and `deepMerge` treats an array as a scalar —
      // so that empty array replaced the default instead of deferring to it,
      // silently disarming the `shell.execute_destructive` entry. Setting the
      // variable to an empty string still means "deny nothing"; it just has to
      // be said out loud now.
      unattendedDenyActions:
        process.env.UNATTENDED_DENY_ACTIONS !== undefined
          ? process.env.UNATTENDED_DENY_ACTIONS.split(',')
              .map((a) => a.trim())
              .filter(Boolean)
          : (defaultConfig.multiuser?.unattendedDenyActions ?? []),
    },
    workspace: {
      rootPath: process.env.WORKSPACE_PATH || WORKSPACE_ROOT,
      additionalPaths: process.env.WORKSPACE_ADDITIONAL_PATHS?.split(',').filter(Boolean) || [],
      sessionFolders: true,
      autoIndexFiles: true,
      documentsPath: process.env.DOCUMENTS_PATH || join(WORKSPACE_ROOT, 'documents'),
      maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || '52428800', 10),
      ocrModel: process.env.OCR_MODEL || 'glm-ocr',
      ocrEndpoint: process.env.OCR_ENDPOINT || 'http://localhost:11435',
    },
    oauth: {
      publicUrl: process.env.PUBLIC_URL,
    },
  };
}
