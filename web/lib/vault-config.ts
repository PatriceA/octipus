export interface VaultKeyEntry {
  label: string;
  vaultName: string;
  testProvider?: string;
  placeholder?: string;
  /**
   * When set, the key is saved through the settings endpoint
   * (`PUT /api/settings/<settingsKey>`) instead of a raw vault write.
   * Required for secrets whose value is cached in the runtime config at boot
   * (e.g. `litellm.apiKey`) — the settings path stores them system-scoped AND
   * triggers hot-reload, so a raw vault write would stay stale until restart.
   */
  settingsKey?: string;
}

export interface VaultKeyGroup {
  title: string;
  description: string;
  keys: VaultKeyEntry[];
}

export interface Credential {
  id: string;
  name: string;
  credentialType: string;
  description?: string;
  tags: string[];
  accessCount: string;
  allowedSkills: string[];
  allowedAgents: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  expiresAt?: string;
}

export type CredentialType = 'api_key' | 'oauth_token' | 'password' | 'ssh_key' | 'certificate' | 'other';

export const PROVIDER_KEY_GROUPS: VaultKeyGroup[] = [
  {
    title: 'LLM Provider API Keys',
    description: 'Direct provider access (bypasses LiteLLM). Stored system-wide — shared by the whole instance.',
    keys: [
      { label: 'OpenAI', vaultName: 'openai_api_key', testProvider: 'openai', placeholder: 'sk-...' },
      { label: 'Anthropic', vaultName: 'anthropic_api_key', testProvider: 'anthropic', placeholder: 'sk-ant-...' },
      { label: 'Google Gemini', vaultName: 'gemini_api_key', testProvider: 'gemini' },
      { label: 'Vertex AI (service account JSON)', vaultName: 'vertex_service_account', testProvider: 'vertex', placeholder: '{ "type": "service_account", "project_id": "...", "client_email": "...", "private_key": "..." }' },
      { label: 'Grok (xAI)', vaultName: 'xai_api_key', testProvider: 'grok', placeholder: 'xai-...' },
      { label: 'DeepSeek', vaultName: 'deepseek_api_key', testProvider: 'deepseek', placeholder: 'sk-...' },
      { label: 'Mistral AI', vaultName: 'mistral_api_key', testProvider: 'mistral' },
      { label: 'OpenRouter', vaultName: 'openrouter_api_key', testProvider: 'openrouter', placeholder: 'sk-or-...' },
      { label: 'Voyage AI (Embeddings)', vaultName: 'voyage_api_key', testProvider: 'voyage', placeholder: 'pa-...' },
      { label: 'Custom Provider', vaultName: 'custom_api_key', placeholder: 'API key for custom OpenAI-compatible providers' },
    ],
  },
  {
    title: 'LiteLLM Proxy',
    description: 'Master key for your LiteLLM proxy. Set the proxy URL under Settings → Configuration → LiteLLM. Stored system-wide and applied without a restart.',
    keys: [
      {
        label: 'LiteLLM Master Key',
        vaultName: 'litellm_api_key',
        settingsKey: 'litellm.apiKey',
        placeholder: 'sk-... (proxy master_key)',
      },
    ],
  },
];

export const OAUTH_KEY_GROUPS: VaultKeyGroup[] = [
  {
    title: 'Google OAuth Credentials',
    description: 'Required for Google Workspace integration (Gmail, Calendar, Drive).',
    keys: [
      { label: 'Client ID', vaultName: 'google_oauth_client_id', placeholder: '...apps.googleusercontent.com' },
      { label: 'Client Secret', vaultName: 'google_oauth_client_secret', placeholder: 'GOCSPX-...' },
    ],
  },
  {
    title: 'Microsoft OAuth Credentials',
    description: 'Required for Microsoft 365 integration (Outlook, Calendar, OneDrive).',
    keys: [
      { label: 'Client ID', vaultName: 'microsoft_oauth_client_id' },
      { label: 'Client Secret', vaultName: 'microsoft_oauth_client_secret' },
      { label: 'Tenant ID', vaultName: 'microsoft_oauth_tenant_id', placeholder: 'common (or your tenant ID)' },
    ],
  },
];

/**
 * Channel bot secrets. Each is read **system-scoped** by the backend
 * (`getSystemSecret`) — one bot per instance, with end-users linking their own
 * chat via `/link`. They use `settingsKey` so a save goes through
 * `PUT /api/settings/<key>`, which stores them system-scoped AND hot-reloads
 * the channel (a raw user-scoped vault write is invisible to the channel — the
 * exact foot-gun that left Telegram unable to connect). Admin-only.
 */
export const CHANNEL_KEY_GROUPS: VaultKeyGroup[] = [
  {
    title: 'Telegram Bot',
    description: 'Bot token from @BotFather. Stored system-wide; users link their own chat with /link.',
    keys: [
      { label: 'Bot Token', vaultName: 'telegram_bot_token', settingsKey: 'telegram.botToken', placeholder: '123456:ABC-DEF...' },
    ],
  },
  {
    title: 'Slack App',
    description: 'Credentials from your Slack app (Socket Mode). Stored system-wide; users link their Slack account with /link.',
    keys: [
      { label: 'Bot Token', vaultName: 'slack_bot_token', settingsKey: 'slack.botToken', placeholder: 'xoxb-...' },
      { label: 'App Token', vaultName: 'slack_app_token', settingsKey: 'slack.appToken', placeholder: 'xapp-...' },
      { label: 'Signing Secret', vaultName: 'slack_signing_secret', settingsKey: 'slack.signingSecret' },
    ],
  },
  {
    title: 'Microsoft Teams',
    description: 'Bot app password (client secret). App ID and Tenant ID are set under Settings → Channels. Stored system-wide.',
    keys: [
      { label: 'App Password', vaultName: 'teams_app_password', settingsKey: 'teams.appPassword' },
    ],
  },
  {
    title: 'WhatsApp Business',
    description: 'Cloud API credentials. Phone number ID and verify token are set under Settings → Channels. Stored system-wide.',
    keys: [
      { label: 'Access Token', vaultName: 'whatsapp_access_token', settingsKey: 'whatsapp.accessToken' },
      { label: 'App Secret', vaultName: 'whatsapp_app_secret', settingsKey: 'whatsapp.appSecret' },
    ],
  },
];

export const ALL_VAULT_KEYS = [
  ...PROVIDER_KEY_GROUPS.flatMap((g) => g.keys),
  ...OAUTH_KEY_GROUPS.flatMap((g) => g.keys),
  ...CHANNEL_KEY_GROUPS.flatMap((g) => g.keys),
];

/**
 * Vault names that are managed as **system-scoped** secrets via the cards on
 * this page. Saving any of these as a user/workspace secret through the generic
 * vault table has no effect — the backend reads them with `getSystemSecret`.
 * Used to warn in the Add-Secret form.
 */
export const SYSTEM_SCOPED_SECRET_NAMES = new Set<string>(
  ALL_VAULT_KEYS.map((k) => k.vaultName),
);

export const CREDENTIAL_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  api_key: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  oauth_token: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  password: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400' },
  ssh_key: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  certificate: { bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-700 dark:text-teal-400' },
  other: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-700 dark:text-gray-300' },
};
