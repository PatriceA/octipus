import { defaultConfig } from './defaults';
import type { Config } from './schema';

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
      url: process.env.OLLAMA_URL || undefined,
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
      defaultTimeout: parseInt(process.env.AGENT_DEFAULT_TIMEOUT || '900000', 10),
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
      orchestratorTimeoutMs: parseInt(process.env.ORCHESTRATOR_TIMEOUT_MS || '1800000', 10),
      orchestratorHookTimeoutMs: parseInt(process.env.ORCHESTRATOR_HOOK_TIMEOUT_MS || '2700000', 10),
    },
    multiuser: {
      enabled: process.env.MULTIUSER === 'true',
      auditShadow: process.env.MULTIUSER_AUDIT_SHADOW !== 'false',
      // Secure-by-default since the May-5 multi-user flip
      // (defaults.ts + settings-registry already use true). The legacy
      // env loader was left as `=== 'true'` which forced false in
      // env-only tests and made the upstream `permissions.isolation`
      // expectation fail. Single-user installs that need the legacy
      // permissive behavior opt out with MULTIUSER_ENFORCE_PERMISSIONS
      // =false. Blast radius is narrow: the only call site that
      // depended on the system-user bypass is the MCP-bridge route
      // (api/routes/tools.ts), so unrelated single-user e2e tests
      // are unaffected.
      enforcePermissions: process.env.MULTIUSER_ENFORCE_PERMISSIONS !== 'false',
      rlsEnabled: process.env.MULTIUSER_RLS === 'true',
      orgWorkspaces: process.env.MULTIUSER_ORG_WORKSPACES === 'true',
    },
    workspace: {
      rootPath: process.env.WORKSPACE_PATH || './workspace',
      additionalPaths: process.env.WORKSPACE_ADDITIONAL_PATHS?.split(',').filter(Boolean) || [],
      sessionFolders: true,
      autoIndexFiles: true,
      documentsPath: process.env.DOCUMENTS_PATH || './workspace/documents',
      maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE || '52428800', 10),
      ocrModel: process.env.OCR_MODEL || 'glm-ocr',
      ocrEndpoint: process.env.OCR_ENDPOINT || 'http://localhost:11435',
    },
    oauth: {
      publicUrl: process.env.PUBLIC_URL,
    },
  };
}
