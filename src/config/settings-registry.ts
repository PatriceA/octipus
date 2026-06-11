/**
 * Static manifest of all runtime-configurable settings.
 * Used for: DB seeding, migration from env, API validation, UI rendering.
 *
 * `.env` contract (post-streamlined-setup):
 *   - Secrets that boot the system before the DB is reachable:
 *       MASTER_KEY, JWT_SECRET, SESSION_SECRET
 *   - Storage targeting (also pre-DB):
 *       STORAGE_MODE, DATABASE_URL, REDIS_URL, DATA_DIR
 *   - API server bind (pre-config-load):
 *       API_HOST, API_PORT
 *   - One-shot bootstrap that seeds DB on first boot:
 *       BOOTSTRAP_PROVIDER, BOOTSTRAP_MODEL, BOOTSTRAP_API_KEY, BOOTSTRAP_BASE_URL
 *
 * Every other env var listed below in `envVar:` is migrated into the DB
 * (settings table or vault) by migrate-env-to-db.ts on first boot, then
 * the .env entry becomes redundant — users edit values via API/UI.
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
    defaultValue: '',
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
    defaultValue: '',
    description: 'Ollama service URL (leave empty if not using Ollama)',
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

  // ── WhatsApp ──
  {
    key: 'whatsapp.accessToken',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'WhatsApp Cloud API access token',
    isSecret: true,
    vaultName: 'whatsapp_access_token',
    envVar: 'WHATSAPP_ACCESS_TOKEN',
  },
  {
    key: 'whatsapp.phoneNumberId',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'WhatsApp phone number ID',
    isSecret: false,
    envVar: 'WHATSAPP_PHONE_NUMBER_ID',
  },
  {
    key: 'whatsapp.verifyToken',
    category: 'channels',
    valueType: 'string',
    defaultValue: 'octipus-whatsapp-verify',
    description: 'Webhook verification token',
    isSecret: false,
    envVar: 'WHATSAPP_VERIFY_TOKEN',
  },
  {
    key: 'whatsapp.appSecret',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'Meta app secret for webhook signature verification',
    isSecret: true,
    vaultName: 'whatsapp_app_secret',
    envVar: 'WHATSAPP_APP_SECRET',
  },
  {
    key: 'whatsapp.businessAccountId',
    category: 'channels',
    valueType: 'string',
    defaultValue: '',
    description: 'WhatsApp Business Account ID',
    isSecret: false,
    envVar: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
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
    description:
      'Agent max token budget (0 = unlimited). Applies to NEW agents only — running agents keep their spawn-time budget. Open chat tabs need a page reload to show the updated cap.',
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
    key: 'orchestrator.mode',
    category: 'orchestrator',
    valueType: 'string',
    defaultValue: 'auto',
    description:
      'Orchestrator mode: auto (pick by model size, re-derived live), full (swarm), lite (single-step delegation), router (no orchestrator LLM)',
    isSecret: false,
    envVar: 'ORCHESTRATOR_MODE',
  },
  {
    key: 'orchestrator.liteMaxIterations',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 3,
    description: 'Iteration cap for the lite orchestrator loop (full mode uses 25)',
    isSecret: false,
    envVar: 'ORCHESTRATOR_LITE_MAX_ITERATIONS',
  },
  {
    key: 'orchestrator.routerSmallModelMaxParams',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 10_000_000_000,
    description: 'auto mode: models with fewer params than this run in router mode',
    isSecret: false,
    envVar: 'ORCHESTRATOR_ROUTER_MAX_PARAMS',
  },
  {
    key: 'orchestrator.liteModelMaxParams',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 24_000_000_000,
    description: 'auto mode: models with fewer params than this (and >= router threshold) run in lite mode',
    isSecret: false,
    envVar: 'ORCHESTRATOR_LITE_MAX_PARAMS',
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
  {
    key: 'orchestrator.orchestratorTimeoutMs',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 1_800_000,
    description: 'Orchestrator hard wall-clock (ms)',
    isSecret: false,
    envVar: 'ORCHESTRATOR_TIMEOUT_MS',
  },
  {
    key: 'orchestrator.orchestratorHookTimeoutMs',
    category: 'orchestrator',
    valueType: 'number',
    defaultValue: 2_700_000,
    description: 'Orchestrator wall-clock when triggered by a hook (ms)',
    isSecret: false,
    envVar: 'ORCHESTRATOR_HOOK_TIMEOUT_MS',
  },

  // ── Swarm ──
  {
    key: 'swarm.perUserSpawnsPerMinute',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 30,
    description: 'Max swarm child spawns per user per minute',
    isSecret: false,
    envVar: 'SWARM_PER_USER_SPAWNS_PER_MINUTE',
  },
  {
    key: 'swarm.orphanReaperIntervalMs',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 600_000,
    description: 'Orphan reaper cadence (ms)',
    isSecret: false,
    envVar: 'SWARM_ORPHAN_REAPER_INTERVAL_MS',
  },
  {
    key: 'swarm.levelDefaults.orchestrator.tokens',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 200_000,
    description: 'Orchestrator (depth 0) token cap',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.orchestrator.wallMs',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 600_000,
    description: 'Orchestrator (depth 0) wall-clock cap (ms)',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.orchestrator.fanOut',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 6,
    description: 'Orchestrator max direct children',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.agent.tokens',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 80_000,
    description: 'Agent (depth 1) token cap',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.agent.wallMs',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 600_000,
    description: 'Agent (depth 1) wall-clock cap (ms)',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.agent.fanOut',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 4,
    description: 'Agent max direct children (subagents)',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.agent.maxPendingDetached',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 3,
    description: 'Max detached (fire-and-collect) subagents an agent can have in flight',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.subagent.tokens',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 30_000,
    description: 'Subagent (depth 2) token cap',
    isSecret: false,
  },
  {
    key: 'swarm.levelDefaults.subagent.wallMs',
    category: 'swarm',
    valueType: 'number',
    defaultValue: 600_000,
    description: 'Subagent (depth 2) wall-clock cap (ms)',
    isSecret: false,
  },

  // ── Direct LLM providers (API keys land in the vault) ──
  {
    key: 'openrouter.apiKey',
    category: 'providers',
    valueType: 'string',
    defaultValue: '',
    description: 'OpenRouter API key (get one at openrouter.ai/keys)',
    isSecret: true,
    vaultName: 'openrouter_api_key',
    envVar: 'OPENROUTER_API_KEY',
  },
  {
    key: 'openai.apiKey',
    category: 'providers',
    valueType: 'string',
    defaultValue: '',
    description: 'OpenAI API key',
    isSecret: true,
    vaultName: 'openai_api_key',
    envVar: 'OPENAI_API_KEY',
  },
  {
    key: 'anthropic.apiKey',
    category: 'providers',
    valueType: 'string',
    defaultValue: '',
    description: 'Anthropic API key',
    isSecret: true,
    vaultName: 'anthropic_api_key',
    envVar: 'ANTHROPIC_API_KEY',
  },
  {
    key: 'gemini.apiKey',
    category: 'providers',
    valueType: 'string',
    defaultValue: '',
    description: 'Google Gemini API key',
    isSecret: true,
    vaultName: 'gemini_api_key',
    envVar: 'GEMINI_API_KEY',
  },
  {
    key: 'deepseek.apiKey',
    category: 'providers',
    valueType: 'string',
    defaultValue: '',
    description: 'DeepSeek API key',
    isSecret: true,
    vaultName: 'deepseek_api_key',
    envVar: 'DEEPSEEK_API_KEY',
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
    description: 'Auto-index written prose/doc files (.md/.txt/.rst/.csv/.log) into the RAG knowledge base. Code is indexed on demand only (knowledge tool).',
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
    description: 'Path to MCP servers JSON config (leave empty to use database storage)',
    isSecret: false,
    envVar: 'MCP_SERVERS_CONFIG',
  },
  {
    key: 'mcp.servers',
    category: 'integrations',
    valueType: 'json',
    defaultValue: [],
    description: 'MCP server configurations (stored in database)',
    isSecret: false,
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

  // ── Skills (filesystem discovery, agentskills.io spec) ──
  {
    key: 'skills.externalEnabled',
    category: 'skills',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Discover skills from filesystem dirs (~/.octipus/agent/skills, .octipus/skills, etc.) per agentskills.io spec',
    isSecret: false,
    envVar: 'SKILLS_EXTERNAL_ENABLED',
  },
  {
    key: 'skills.externalDirectories',
    category: 'skills',
    valueType: 'string_array',
    defaultValue: [],
    description: 'Extra skill dirs to scan (absolute or ~-prefixed). Recursively finds SKILL.md; root *.md treated as flat skills in pi-style locations.',
    isSecret: false,
    envVar: 'SKILLS_EXTERNAL_DIRS',
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
    defaultValue: 600,
    description: 'Per-user API-call ceiling per window (default maxApiCallsPerMinute). Counts all /api/* calls incl. dashboard polling; ~10 req/s. Lower per-user via /admin/quotas for multi-tenant.',
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
    defaultValue: 'Octipus',
    description: 'TOTP issuer name',
    isSecret: false,
    envVar: 'TOTP_ISSUER',
  },

  // ── Notifications ─────────────────────────────────────────────
  {
    key: 'notifications.agentCompletion',
    category: 'notifications',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Notify when an agent completes its task',
    isSecret: false,
  },
  {
    key: 'notifications.permissionRequest',
    category: 'notifications',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Notify when an agent requests permission',
    isSecret: false,
  },
  {
    key: 'notifications.pipelineApproval',
    category: 'notifications',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Notify when a pipeline stage needs approval',
    isSecret: false,
  },
  {
    key: 'notifications.errors',
    category: 'notifications',
    valueType: 'boolean',
    defaultValue: false,
    description: 'Notify on agent or pipeline errors',
    isSecret: false,
  },
  {
    key: 'voice.telephonyProvider',
    category: 'voice',
    valueType: 'string',
    defaultValue: 'disabled',
    description: 'Telephony provider: twilio, telnyx, plivo, or disabled. Store credentials in the vault (e.g., twilio_account_sid, twilio_auth_token). The phone number is auto-detected from the provider after connecting.',
    isSecret: false,
  },
  {
    key: 'voice.phoneNumber',
    category: 'voice',
    valueType: 'string',
    defaultValue: null,
    description: 'Your phone number (E.164 format, e.g., +1234567890). Auto-detected from Twilio if not set.',
    isSecret: false,
  },
  {
    key: 'voice.publicUrl',
    category: 'voice',
    valueType: 'string',
    defaultValue: null,
    description: 'Public base URL for receiving call webhooks — just the origin, no path (e.g., "https://example.ngrok.io" or "https://app.example.com"). The webhook path /api/voice/webhook/:provider is appended automatically.',
    isSecret: false,
  },
  {
    key: 'voice.inboundPolicy',
    category: 'voice',
    valueType: 'string',
    defaultValue: 'disabled',
    description: 'Inbound call policy: disabled, allowlist, or open',
    isSecret: false,
  },
  {
    key: 'voice.inboundAllowFrom',
    category: 'voice',
    valueType: 'json',
    defaultValue: null,
    description: 'Allowed inbound phone numbers (E.164 format, e.g., ["+1234567890"])',
    isSecret: false,
  },
  {
    key: 'permissions.rules',
    category: 'security',
    valueType: 'json',
    defaultValue: null,
    description: 'Permission rules for tool access control. Format: { allow: ["shell(git:*)"], deny: ["shell(rm -rf:*)"], ask: ["shell(sudo:*)"] }. Rules use tool(matcher) syntax with wildcards.',
    isSecret: false,
  },
  // ── Multi-user (always on; these tune layered features) ──
  {
    key: 'multiuser.auditShadow',
    category: 'multiuser',
    valueType: 'boolean',
    defaultValue: true,
    description: 'When true, the audit middleware records every state-changing request without enforcing anything. Lets operators inspect audit data before enforcing.',
    isSecret: false,
    envVar: 'MULTIUSER_AUDIT_SHADOW',
  },
  {
    key: 'multiuser.enforcePermissions',
    category: 'multiuser',
    valueType: 'boolean',
    defaultValue: true,
    description: 'When true, the orchestrator consults skill_permissions before invoking tools (ALLOW/ASK/DENY). Default since v0.3.',
    isSecret: false,
    envVar: 'MULTIUSER_ENFORCE_PERMISSIONS',
  },
  {
    key: 'multiuser.rlsEnabled',
    category: 'multiuser',
    valueType: 'boolean',
    defaultValue: false,
    description: 'Postgres Row-Level Security (Phase 3b). When true, authenticated queries open a transaction with SET LOCAL app.current_user_id = <principal>; the policies installed by migration 0034 enforce per-row ownership in addition to the application-layer scoped repos. Requires external Postgres + a non-superuser app role for the policies to actually fire — PGlite ignores RLS, so embedded installs are unaffected.',
    isSecret: false,
    envVar: 'MULTIUSER_RLS',
  },
  {
    key: 'multiuser.orgWorkspaces',
    category: 'multiuser',
    valueType: 'boolean',
    defaultValue: true,
    description: 'Phase 4 — exposes /api/me/workspaces and /api/orgs/* and activates the X-Octipus-Workspace header resolver. Off by default so single-user installs see no surface change.',
    isSecret: false,
    envVar: 'MULTIUSER_ORG_WORKSPACES',
  },

  // ── Live Artifacts ──
  {
    key: 'artifacts.host',
    category: 'artifacts',
    valueType: 'string',
    defaultValue: '',
    description: 'Subdomain that serves hosted artifact pages (e.g. "artifacts.octipus.cc"). Empty → fall back to /__artifacts__/* on the main host with weaker isolation. Add the DNS record in your provider before setting this.',
    isSecret: false,
    envVar: 'ARTIFACTS_HOST',
  },
  {
    key: 'artifacts.proto',
    category: 'artifacts',
    valueType: 'string',
    defaultValue: 'https',
    description: 'Protocol for artifact embed URLs ("https" or "http"). Use "http" only for local dev.',
    isSecret: false,
    envVar: 'ARTIFACTS_PROTO',
  },
  {
    key: 'artifacts.gatewayWss',
    category: 'artifacts',
    valueType: 'string',
    defaultValue: '',
    description: 'Gateway WebSocket origin baked into embed CSP connect-src (e.g. "wss://octipus.cc/gateway"). Leave empty to skip the connect-src pin (live updates may be blocked).',
    isSecret: false,
    envVar: 'ARTIFACTS_GATEWAY_WSS',
  },
  {
    key: 'artifacts.tokenSecret',
    category: 'artifacts',
    valueType: 'string',
    defaultValue: '',
    description: 'HMAC key for artifact-scoped JWTs. Auto-generated on first boot — you don\'t need to set this. Rotate (clear + save to regenerate on next boot) to invalidate all in-flight embed tokens.',
    isSecret: true,
    envVar: 'ARTIFACT_TOKEN_SECRET',
  },
  {
    key: 'artifacts.sdkSha256',
    category: 'artifacts',
    valueType: 'string',
    defaultValue: '',
    description: 'Sha256 of /octipus-artifact-client.js — auto-loaded from web/public/octipus-artifact-client.sha256.txt at boot. Override only if hosting the SDK from a different path.',
    isSecret: false,
    envVar: 'ARTIFACT_SDK_SHA256',
  },
  {
    key: 'artifacts.bundlesDir',
    category: 'artifacts',
    valueType: 'string',
    defaultValue: '',
    description: 'Filesystem root for custom JS bundles. Empty → defaults to ./data/artifacts under the project root.',
    isSecret: false,
    envVar: 'ARTIFACT_BUNDLES_DIR',
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
