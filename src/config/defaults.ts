import type { Config } from './schema';

export const defaultConfig: Partial<Config> = {
  storageMode: 'external',
  database: {
    url: '', // Must be set via DATABASE_URL env var in external mode
    dataDir: '~/.octipus/data',
    poolSize: 10,
    idleTimeout: 30000,
    connectionTimeout: 10000,
  },
  redis: {
    url: 'redis://localhost:6379',
    keyPrefix: 'octipus:',
    maxRetries: 3,
    retryDelay: 1000,
  },
  litellm: {
    proxyUrl: 'http://localhost:4000',
    timeout: 120000,
    maxRetries: 3,
  },
  ollama: {
    defaultModel: 'llama3.2',
  },
  security: {
    masterKey: '', // Must be provided
    jwtSecret: '', // Must be provided
    sessionSecret: '', // Must be provided
    sessionMaxAge: 86400000,
    totpIssuer: 'Octipus',
    passkeyRpId: 'localhost',
    passkeyRpName: 'Octipus',
    passkeyOrigin: 'http://localhost:3000',
    shellSandbox: 'off',
  },
  api: {
    host: '0.0.0.0',
    port: 3000,
    corsOrigins: ['http://localhost:3001'],
    rateLimitWindow: 60000,
    rateLimitMax: 100,
  },
  voice: {
    sttEnabled: false,
    ttsEnabled: false,
    language: 'en',
  },
  mcp: {
    autoStart: true,
    connectionTimeout: 30000,
  },
  logging: {
    level: 'info',
    format: 'pretty',
  },
  agent: {
    maxConcurrentAgents: 10,
    defaultTimeout: 900000,
    maxIterations: 50,
    contextWindowSize: 32000,
    maxTokenBudget: 100000,
  },
  orchestrator: {
    enabled: true,
    piiFilterEnabled: true,
    maxPipelineStages: 10,
    approvalTimeoutMs: 3600000,
    workerTimeoutMs: 600000,
    /** Orchestrator agent timeout for interactive channels (30 min). */
    orchestratorTimeoutMs: 1800000,
    /** Orchestrator agent timeout for unattended hook-triggered runs (45 min). */
    orchestratorHookTimeoutMs: 2700000,
  },
  multiuser: {
    enabled: false,
    auditShadow: true,
    enforcePermissions: false,
    rlsEnabled: false,
  },
  workspace: {
    rootPath: './workspace',
    additionalPaths: [],
    sessionFolders: true,
    autoIndexFiles: true,
    documentsPath: './workspace/documents',
    maxUploadSize: 52428800,
    ocrModel: 'glm-ocr',
    ocrEndpoint: 'http://localhost:11435',
  },
  compaction: {
    minSavingsRatio: 0.10,
    growthMultiplier: 2.0,
    hardCeiling: 1_000_000,
  },
  swarm: {
    perUserSpawnsPerMinute: 30,
    orphanReaperIntervalMs: 600_000,
    levelDefaults: {
      orchestrator: { tokens: 200_000, wallMs: 600_000, fanOut: 6, maxPendingDetached: 0 },
      agent: { tokens: 80_000, wallMs: 240_000, fanOut: 4, maxPendingDetached: 3 },
      subagent: { tokens: 30_000, wallMs: 240_000, fanOut: 0, maxPendingDetached: 0 },
    },
  },
};

/** Required env vars — DATABASE_URL and REDIS_URL only needed in external mode */
export const requiredEnvVars = [
  'MASTER_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
];

/** Additional env vars required only in external storage mode */
export const externalModeRequiredVars = [
  'DATABASE_URL',
];

export const optionalEnvVars = [
  'REDIS_URL',
  'LITELLM_PROXY_URL',
  'LITELLM_API_KEY',
  'OLLAMA_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USERS',
  'TEAMS_APP_ID',
  'TEAMS_APP_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'WHISPER_MODEL_PATH',
  'PIPER_MODEL_PATH',
  'API_HOST',
  'API_PORT',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'N8N_URL',
  'N8N_API_KEY',
  'MCP_SERVERS_CONFIG',
  'WORKSPACE_PATH',
  'WORKSPACE_ADDITIONAL_PATHS',
  'PUBLIC_URL',
];
