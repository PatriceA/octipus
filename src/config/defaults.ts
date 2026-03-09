import type { Config } from './schema';

export const defaultConfig: Partial<Config> = {
  storageMode: 'external',
  database: {
    url: '', // Must be set via DATABASE_URL env var in external mode
    dataDir: '~/.assistant/data',
    poolSize: 10,
    idleTimeout: 30000,
    connectionTimeout: 10000,
  },
  redis: {
    url: 'redis://localhost:6379',
    keyPrefix: 'assistant:',
    maxRetries: 3,
    retryDelay: 1000,
  },
  litellm: {
    proxyUrl: 'http://localhost:4000',
    timeout: 120000,
    maxRetries: 3,
  },
  ollama: {
    url: 'http://localhost:11434',
    defaultModel: 'llama3.2',
  },
  security: {
    masterKey: '', // Must be provided
    jwtSecret: '', // Must be provided
    sessionSecret: '', // Must be provided
    sessionMaxAge: 86400000,
    totpIssuer: 'Assistant',
    passkeyRpId: 'localhost',
    passkeyRpName: 'Assistant',
    passkeyOrigin: 'http://localhost:3000',
  },
  api: {
    host: '127.0.0.1',
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
  },
  workspace: {
    rootPath: './workspace',
    additionalPaths: [],
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
