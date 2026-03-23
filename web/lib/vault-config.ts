export interface VaultKeyEntry {
  label: string;
  vaultName: string;
  testProvider?: string;
  placeholder?: string;
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
    description: 'Store API keys for direct provider access (bypasses LiteLLM).',
    keys: [
      { label: 'OpenAI', vaultName: 'openai_api_key', testProvider: 'openai', placeholder: 'sk-...' },
      { label: 'Anthropic', vaultName: 'anthropic_api_key', testProvider: 'anthropic', placeholder: 'sk-ant-...' },
      { label: 'Google Gemini', vaultName: 'gemini_api_key', testProvider: 'gemini' },
      { label: 'DeepSeek', vaultName: 'deepseek_api_key', testProvider: 'deepseek', placeholder: 'sk-...' },
      { label: 'Voyage AI (Embeddings)', vaultName: 'voyage_api_key', testProvider: 'voyage', placeholder: 'pa-...' },
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

export const ALL_VAULT_KEYS = [
  ...PROVIDER_KEY_GROUPS.flatMap((g) => g.keys),
  ...OAUTH_KEY_GROUPS.flatMap((g) => g.keys),
];

export const CREDENTIAL_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  api_key: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  oauth_token: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  password: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400' },
  ssh_key: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  certificate: { bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-700 dark:text-teal-400' },
  other: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-700 dark:text-gray-300' },
};
