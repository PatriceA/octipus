/**
 * Static manifest of all runtime-configurable settings.
 * Used for: DB seeding, migration from env, API validation, UI rendering.
 */

export type SettingValueType = 'string' | 'number' | 'boolean' | 'json' | 'string_array';

export interface SettingDefinition {
  key: string;
  category: string;
  valueType: SettingValueType;
  defaultValue: unknown;
  description: string;
  isSecret: boolean;
  /** For secrets: the vault credential name */
  vaultName?: string;
  /** The old env var name, used during migration from .env */
  envVar?: string;
}

/**
 * Map a dot-path key to its position in the Config object.
 * e.g. 'litellm.proxyUrl' → config.litellm.proxyUrl
 */
export function settingKeyToConfigPath(key: string): string[] {
  return key.split('.');
}

export const SETTINGS_REGISTRY: SettingDefinition[] = [
  // ── LiteLLM ──
  {
    key: 'litellm.proxyUrl',
    category: 'litellm',
    valueType: 'string',
    defaultValue: 'http://localhost:4000',
    description: 'LiteLLM proxy URL',
    isSecret: false,
    envVar: 'LITELLM_URL',
  },
  {
    key: 'litellm.apiKey',
    category: 'litellm',
    valueType: 'string',
    defaultValue: '',
    description: 'LiteLLM API key',
    isSecret: true,
    vaultName: 'litellm_api_key',
    envVar: 'LITELLM_API_KEY',
  },
  {
    key: 'litellm.timeout',
    category: 'litellm',
    valueType: 'number',
    defaultValue: 120000,
    description: 'LiteLLM request timeout (ms)',
    isSecret: false,
    envVar: 'LITELLM_TIMEOUT',
  },
  {
    key: 'litellm.maxRetries',
    category: 'litellm',
    valueType: 'number',
    defaultValue: 3,
    description: 'LiteLLM max retries',
    isSecret: false,
    envVar: 'LITELLM_MAX_RETRIES',
  },

  // ── Ollama ──
  {
    key: 'ollama.url',
    category: 'ollama',
    valueType: 'string',
    defaultValue: 'http://localhost:11434',
    description: 'Ollama service URL',
    isSecret: false,
    envVar: 'OLLAMA_URL',
  },
  {
    key: 'ollama.defaultModel',
    category: 'ollama',
    valueType: 'string',
    defaultValue: 'llama3.2',
    description: 'Default Ollama model',
    isSecret: false,
    envVar: 'OLLAMA_DEFAULT_MODEL',
  },

  // ── Telegram ──
  {
    key: 'telegram.botToken',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Telegram bot token',
    isSecret: true,
    vaultName: 'telegram_bot_token',
    envVar: 'TELEGRAM_BOT_TOKEN',
  },
  {
    key: 'telegram.allowedUsers',
    category: 'channels',
    valueType: 'string_array',
    defaultValue: [],
    description: 'Telegram allowed user IDs',
    isSecret: false,
    envVar: 'TELEGRAM_ALLOWED_USERS',
  },
  {
    key: 'telegram.webhookUrl',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Telegram webhook URL (leave empty for polling)',
    isSecret: false,
    envVar: 'TELEGRAM_WEBHOOK_URL',
  },
  {
    key: 'telegram.pollingTimeout',
    category: 'channels',
    valueType: 'number',
    defaultValue: 30,
    description: 'Telegram polling timeout (seconds)',
    isSecret: false,
    envVar: 'TELEGRAM_POLLING_TIMEOUT',
  },

  // ── Slack ──
  {
    key: 'slack.botToken',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Slack bot token',
    isSecret: true,
    vaultName: 'slack_bot_token',
    envVar: 'SLACK_BOT_TOKEN',
  },
  {
    key: 'slack.appToken',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Slack app token',
    isSecret: true,
    vaultName: 'slack_app_token',
    envVar: 'SLACK_APP_TOKEN',
  },
  {
    key: 'slack.signingSecret',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Slack signing secret',
    isSecret: true,
    vaultName: 'slack_signing_secret',
    envVar: 'SLACK_SIGNING_SECRET',
  },

  // ── Teams ──
  {
    key: 'teams.appId',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Microsoft Teams app ID',
    isSecret: false,
    envVar: 'TEAMS_APP_ID',
  },
  {
    key: 'teams.appPassword',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Microsoft Teams app password',
    isSecret: true,
    vaultName: 'teams_app_password',
    envVar: 'TEAMS_APP_PASSWORD',
  },
  {
    key: 'teams.tenantId',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Microsoft Teams tenant ID',
    isSecret: false,
    envVar: 'TEAMS_TENANT_ID',
  },

  // ── Agent ──
  {
    key: 'agent.maxConcurrentAgents',
    category: 'agent',
    valueType: 'number',
    defaultValue: 10,
    description: 'Maximum concurrent agents',
    isSecret: false,
    envVar: 'MAX_CONCURRENT_AGENTS',
  },
  {
    key: 'agent.defaultTimeout',
    category: 'agent',
    valueType: 'number',
    defaultValue: 900000,
    description: 'Agent default timeout in ms (0 = no timeout)',
    isSecret: false,
    envVar: 'AGENT_DEFAULT_TIMEOUT',
  },
  {
    key: 'agent.maxIterations',
    category: 'agent',
    valueType: 'number',
    defaultValue: 50,
    description: 'Agent max tool-loop iterations',
    isSecret: false,
    envVar: 'AGENT_MAX_ITERATIONS',
  },
  {
    key: 'agent.contextWindowSize',
    category: 'agent',
    valueType: 'number',
    defaultValue: 32000,
    description: 'Agent context window size (tokens)',
    isSecret: false,
    envVar: 'CONTEXT_WINDOW_SIZE',
  },
  {
    key: 'agent.maxTokenBudget',
    category: 'agent',
    valueType: 'number',
    defaultValue: 100000,
    description: 'Agent max token budget (0 = unlimited)',
    isSecret: false,
    envVar: 'AGENT_MAX_TOKEN_BUDGET',
  },

  // ── Orchestrator ──
  {
    key: 'orchestrator.enabled',
    category: 'orchestrator',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Enable orchestrator/pipelines',
    isSecret: false,
    envVar: 'ORCHESTRATOR_ENABLED',
  },
  {
    key: 'orchestrator.defaultModel',
    category: 'orchestrator',
    valueType: 'string',
    defaultValue: '',
    description: 'Override model for orchestrator (empty = use DB default)',
    isSecret: false,
    envVar: 'ORCHESTRATOR_MODEL',
  },
  {
    key: 'orchestrator.piiFilterEnabled',
    category: 'orchestrator',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Enable PII filter',
    isSecret: false,
    envVar: 'PII_FILTER_ENABLED',
  },
  {
    key: 'orchestrator.maxPipelineStages',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 10,
    description: 'Max pipeline stages',
    isSecret: false,
    envVar: 'MAX_PIPELINE_STAGES',
  },
  {
    key: 'orchestrator.approvalTimeoutMs',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 3600000,
    description: 'Approval timeout (ms)',
    isSecret: false,
    envVar: 'APPROVAL_TIMEOUT_MS',
  },
  {
    key: 'orchestrator.workerTimeoutMs',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 600000,
    description: 'Worker timeout (ms)',
    isSecret: false,
    envVar: 'WORKER_TIMEOUT_MS',
  },

  // ── Workspace ──
  {
    key: 'workspace.rootPath',
    category: 'workspace',
    valueType: 'string',
    defaultValue: './workspace',
    description: 'Workspace root directory',
    isSecret: false,
    envVar: 'WORKSPACE_PATH',
  },
  {
    key: 'workspace.additionalPaths',
    category: 'workspace',
    valueType: 'string_array',
    defaultValue: [],
    description: 'Additional workspace paths',
    isSecret: false,
    envVar: 'WORKSPACE_ADDITIONAL_PATHS',
  },
  {
    key: 'workspace.sessionFolders',
    category: 'workspace',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Create per-session output directories (workspace/sessions/<date>-<topic>/)',
    isSecret: false,
  },
  {
    key: 'workspace.autoIndexFiles',
    category: 'workspace',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Automatically index written files into the RAG knowledge base',
    isSecret: false,
  },

  // ── Logging ──
  {
    key: 'logging.level',
    category: 'logging',
    valueType: 'string',
    defaultValue: 'info',
    description: 'Log level (trace|debug|info|warn|error|fatal)',
    isSecret: false,
    envVar: 'LOG_LEVEL',
  },
  {
    key: 'logging.format',
    category: 'logging',
    valueType: 'string',
    defaultValue: 'pretty',
    description: 'Log format (pretty|json)',
    isSecret: false,
    envVar: 'LOG_FORMAT',
  },
  {
    key: 'logging.file',
    category: 'logging',
    valueType: 'string',
    defaultValue: '',
    description: 'Log file path (empty = stdout only)',
    isSecret: false,
    envVar: 'LOG_FILE',
  },

  // ── Voice ──
  {
    key: 'voice.whisperModelPath',
    category: 'voice',
    valueType: 'string',
    defaultValue: './models/whisper/ggml-base.bin',
    description: 'Path to Whisper STT model (ggml format)',
    isSecret: false,
    envVar: 'WHISPER_MODEL_PATH',
  },
  {
    key: 'voice.piperModelPath',
    category: 'voice',
    valueType: 'string',
    defaultValue: '',
    description: 'Path to Piper TTS model',
    isSecret: false,
    envVar: 'PIPER_MODEL_PATH',
  },
  {
    key: 'voice.language',
    category: 'voice',
    valueType: 'string',
    defaultValue: 'en',
    description: 'Voice language code',
    isSecret: false,
    envVar: 'VOICE_LANGUAGE',
  },
  {
    key: 'voice.wakeWord',
    category: 'voice',
    valueType: 'string',
    defaultValue: '',
    description: 'Wake word for voice activation',
    isSecret: false,
    envVar: 'WAKE_WORD',
  },

  // ── Integrations ──
  {
    key: 'n8n.url',
    category: 'integrations',
    valueType: 'string',
    defaultValue: '',
    description: 'N8N service URL',
    isSecret: false,
    envVar: 'N8N_URL',
  },
  {
    key: 'n8n.apiKey',
    category: 'integrations',
    valueType: 'string',
    defaultValue: '',
    description: 'N8N API key',
    isSecret: true,
    vaultName: 'n8n_api_key',
    envVar: 'N8N_API_KEY',
  },
  {
    key: 'n8n.webhookPath',
    category: 'integrations',
    valueType: 'string',
    defaultValue: '/n8n/webhook',
    description: 'N8N webhook path',
    isSecret: false,
    envVar: 'N8N_WEBHOOK_PATH',
  },
  {
    key: 'mcp.serversConfigPath',
    category: 'integrations',
    valueType: 'string',
    defaultValue: '',
    description: 'Path to MCP servers JSON config',
    isSecret: false,
    envVar: 'MCP_SERVERS_CONFIG',
  },
  {
    key: 'mcp.autoStart',
    category: 'integrations',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Auto-connect to MCP servers on startup',
    isSecret: false,
    envVar: 'MCP_AUTO_START',
  },
  {
    key: 'mcp.connectionTimeout',
    category: 'integrations',
    valueType: 'number',
    defaultValue: 30000,
    description: 'MCP connection timeout (ms)',
    isSecret: false,
    envVar: 'MCP_CONNECTION_TIMEOUT',
  },

  // ── OAuth ──
  {
    key: 'oauth.publicUrl',
    category: 'integrations',
    valueType: 'string',
    defaultValue: '',
    description: 'Public URL for OAuth callbacks',
    isSecret: false,
    envVar: 'PUBLIC_URL',
  },

  // ── API (runtime-changeable subset) ──
  {
    key: 'api.corsOrigins',
    category: 'api',
    valueType: 'string_array',
    defaultValue: ['http://localhost:3001'],
    description: 'CORS allowed origins',
    isSecret: false,
    envVar: 'CORS_ORIGINS',
  },
  {
    key: 'api.rateLimitWindow',
    category: 'api',
    valueType: 'number',
    defaultValue: 60000,
    description: 'Rate limit window (ms)',
    isSecret: false,
    envVar: 'RATE_LIMIT_WINDOW',
  },
  {
    key: 'api.rateLimitMax',
    category: 'api',
    valueType: 'number',
    defaultValue: 100,
    description: 'Rate limit max requests per window',
    isSecret: false,
    envVar: 'RATE_LIMIT_MAX',
  },

  // ── Security (runtime-changeable subset) ──
  {
    key: 'security.sessionMaxAge',
    category: 'security',
    valueType: 'number',
    defaultValue: 86400000,
    description: 'Session max age (ms)',
    isSecret: false,
    envVar: 'SESSION_MAX_AGE',
  },
  {
    key: 'security.totpIssuer',
    category: 'security',
    valueType: 'string',
    defaultValue: 'Assistant',
    description: 'TOTP issuer name',
    isSecret: false,
    envVar: 'TOTP_ISSUER',
  },
];

/** Get a setting definition by key */
export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_REGISTRY.find(d => d.key === key);
}

/** Get all setting definitions for a category */
export function getSettingsByCategory(category: string): SettingDefinition[] {
  return SETTINGS_REGISTRY.filter(d => d.category === category);
}

/** Get all unique categories */
export function getCategories(): string[] {
  return [...new Set(SETTINGS_REGISTRY.map(d => d.category))];
}
