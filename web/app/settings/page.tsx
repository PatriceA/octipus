'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Settings,
  Key,
  Bell,
  MessageSquare,
  Loader2,
  Link2,
  CheckCircle,
  XCircle,
  Send,
  Plug,
  FolderOpen,
  Plus,
  Trash2,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { api } from '@/lib/api';

interface UserProfile {
  id: string;
  username: string;
  email?: string;
  isAdmin: boolean;
  totpEnabled: boolean;
  channelBindings?: ChannelBinding[];
  preferences?: {
    theme?: string;
    language?: string;
    notifications?: boolean;
    defaultModel?: string;
    timezone?: string;
  };
}

interface ChannelBinding {
  channelType: string;
  channelUserId: string;
  channelUserName?: string;
  isVerified: boolean;
  createdAt: string;
}

interface HealthStatus {
  services: Record<string, { status: string; latency?: number }>;
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general');
  const queryClient = useQueryClient();

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'channels', label: 'Channels', icon: MessageSquare },
    { id: 'security', label: 'Security', icon: Key },
    { id: 'notifications', label: 'Notifications', icon: Bell },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-gray-600 dark:text-gray-400">Configure your assistant</p>
      </div>

      <div className="flex gap-6">
        <div className="w-48 space-y-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'integrations' && <IntegrationsTab />}
          {activeTab === 'channels' && <ChannelsTab />}
          {activeTab === 'security' && <SecurityTab />}
          {activeTab === 'notifications' && <NotificationsTab />}
        </div>
      </div>
    </div>
  );
}

function GeneralTab() {
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<UserProfile>('/auth/me'),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      try {
        return await api.get<HealthStatus>('/health');
      } catch {
        return null;
      }
    },
  });

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">General Settings</h2>

      {/* Service Status */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Service Status</h3>
        <div className="grid grid-cols-2 gap-2">
          {health &&
            typeof health === 'object' &&
            'services' in health &&
            Object.entries((health as HealthStatus).services || {}).map(([name, svc]) => (
              <div
                key={name}
                className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
              >
                <span className="text-sm text-gray-700 dark:text-gray-300 capitalize">{name}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    svc.status === 'healthy'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                  }`}
                >
                  {svc.status}
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Profile */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Profile</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Username</label>
            <input
              type="text"
              value={profile?.username || ''}
              readOnly
              className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-sm dark:text-white"
            />
          </div>
          {profile?.email && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email</label>
              <input
                type="text"
                value={profile.email}
                readOnly
                className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-sm dark:text-white"
              />
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <span
              className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                profile?.isAdmin
                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {profile?.isAdmin ? 'Admin' : 'User'}
            </span>
          </div>
        </div>
      </div>

      {/* Provider API Keys */}
      <ProviderKeysSection />
    </div>
  );
}

interface VaultKeyEntry {
  label: string;
  vaultName: string;
  testProvider?: string;
  placeholder?: string;
}

interface VaultKeyGroup {
  title: string;
  description: string;
  keys: VaultKeyEntry[];
}

const VAULT_KEY_GROUPS: VaultKeyGroup[] = [
  {
    title: 'LLM Provider API Keys',
    description: 'Store API keys for direct provider access (bypasses LiteLLM).',
    keys: [
      { label: 'OpenAI', vaultName: 'openai_api_key', testProvider: 'openai', placeholder: 'sk-...' },
      { label: 'Anthropic', vaultName: 'anthropic_api_key', testProvider: 'anthropic', placeholder: 'sk-ant-...' },
      { label: 'Google Gemini', vaultName: 'gemini_api_key', testProvider: 'gemini' },
      { label: 'DeepSeek', vaultName: 'deepseek_api_key', testProvider: 'deepseek', placeholder: 'sk-...' },
    ],
  },
  {
    title: 'Google OAuth Credentials',
    description: 'Required for Google Workspace integration (Gmail, Calendar, Drive). Create at console.cloud.google.com/apis/credentials.',
    keys: [
      { label: 'Client ID', vaultName: 'google_oauth_client_id', placeholder: '...apps.googleusercontent.com' },
      { label: 'Client Secret', vaultName: 'google_oauth_client_secret', placeholder: 'GOCSPX-...' },
    ],
  },
  {
    title: 'Microsoft OAuth Credentials',
    description: 'Required for Microsoft 365 integration (Outlook, Calendar, OneDrive). Create at portal.azure.com.',
    keys: [
      { label: 'Client ID', vaultName: 'microsoft_oauth_client_id' },
      { label: 'Client Secret', vaultName: 'microsoft_oauth_client_secret' },
      { label: 'Tenant ID', vaultName: 'microsoft_oauth_tenant_id', placeholder: 'common (or your tenant ID)' },
    ],
  },
];

const ALL_VAULT_KEYS = VAULT_KEY_GROUPS.flatMap((g) => g.keys);

function ProviderKeysSection() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ credentials?: { name: string }[] }>('/vault').then((data) => {
      const creds = data?.credentials ?? [];
      const s: Record<string, boolean> = {};
      for (const k of ALL_VAULT_KEYS) {
        s[k.vaultName] = creds.some((c) => c.name === k.vaultName);
      }
      setStatuses(s);
    }).catch(() => {});
  }, []);

  const handleSave = async (vaultName: string) => {
    const value = keys[vaultName];
    if (!value) return;
    setSaving(vaultName);
    try {
      await api.post('/vault', {
        name: vaultName,
        value,
        credentialType: 'api_key',
        description: `Credential: ${vaultName}`,
        tags: ['provider'],
        systemLevel: true,
      });
      setStatuses((s) => ({ ...s, [vaultName]: true }));
      setKeys((k) => ({ ...k, [vaultName]: '' }));
    } catch { /* ignore */ }
    setSaving(null);
  };

  const handleTest = async (provider: string, vaultName: string) => {
    setTesting(vaultName);
    try {
      const known = await api.get<{ models: string[] }>(`/models/providers/${provider}/known`);
      const modelId = known.models?.[0];
      if (modelId) {
        const result = await api.post<{ success: boolean; message?: string; error?: string }>('/models/test', {
          provider,
          modelId,
        });
        alert(result.success ? `Connected: ${result.message}` : `Failed: ${result.error}`);
      }
    } catch (err) {
      alert(`Test failed: ${(err as Error).message}`);
    }
    setTesting(null);
  };

  return (
    <div className="space-y-5">
      {VAULT_KEY_GROUPS.map((group) => (
        <div key={group.title}>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{group.title}</h3>
          <p className="text-xs text-gray-500 mb-3">{group.description}</p>
          <div className="space-y-2">
            {group.keys.map((k) => (
              <div key={k.vaultName} className="flex items-center gap-2">
                <div className="w-28 text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1.5 shrink-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${statuses[k.vaultName] ? 'bg-green-500' : 'bg-gray-400'}`} />
                  {k.label}
                </div>
                <input
                  type="password"
                  value={keys[k.vaultName] || ''}
                  onChange={(e) => setKeys((prev) => ({ ...prev, [k.vaultName]: e.target.value }))}
                  placeholder={statuses[k.vaultName] ? 'Saved (enter new value to replace)' : k.placeholder || 'Enter value...'}
                  className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
                <button
                  onClick={() => handleSave(k.vaultName)}
                  disabled={!keys[k.vaultName] || saving === k.vaultName}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving === k.vaultName ? '...' : 'Save'}
                </button>
                {statuses[k.vaultName] && k.testProvider && (
                  <button
                    onClick={() => handleTest(k.testProvider!, k.vaultName)}
                    disabled={testing === k.vaultName}
                    className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    {testing === k.vaultName ? '...' : 'Test'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Integrations Tab ---

interface WorkspaceConfig {
  rootPath: string;
  additionalPaths: string[];
}

interface OAuthStatus {
  connected: boolean;
  provider: string;
  email?: string;
  scopes?: string[];
  expiresAt?: string;
}

function IntegrationsTab() {
  return (
    <div className="space-y-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Integrations</h2>
      <WorkspaceSection />
      <hr className="border-gray-200 dark:border-gray-700" />
      <CLIIntegrationsSection />
      <hr className="border-gray-200 dark:border-gray-700" />
      <OAuthIntegrationsSection />
    </div>
  );
}

function WorkspaceSection() {
  const queryClient = useQueryClient();
  const { data: workspace, isLoading: wsLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<WorkspaceConfig>('/workspace'),
  });
  const [newPath, setNewPath] = useState('');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleAddPath = async () => {
    if (!newPath.trim() || !workspace) return;
    setValidating(true);
    setError('');

    try {
      const validation = await api.post<{ path: string; valid: boolean }>('/workspace/validate', { path: newPath.trim() });
      if (!validation.valid) {
        setError(`Path "${newPath}" does not exist or is not a directory`);
        setValidating(false);
        return;
      }

      const updated = [...workspace.additionalPaths, validation.path];
      setSaving(true);
      await api.put<WorkspaceConfig>('/workspace', { additionalPaths: updated });
      queryClient.invalidateQueries({ queryKey: ['workspace'] });
      setNewPath('');
    } catch (err) {
      setError((err as Error).message);
    }
    setValidating(false);
    setSaving(false);
  };

  const handleRemovePath = async (index: number) => {
    if (!workspace) return;
    setSaving(true);
    setError('');
    try {
      const updated = workspace.additionalPaths.filter((_, i) => i !== index);
      await api.put<WorkspaceConfig>('/workspace', { additionalPaths: updated });
      queryClient.invalidateQueries({ queryKey: ['workspace'] });
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <FolderOpen className="w-4 h-4 text-gray-500" />
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Workspace Paths</h3>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Directories the agent can access. The root path is set via environment variable.
      </p>

      {/* Root path (read-only) */}
      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">Root Path</label>
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm text-gray-700 dark:text-gray-300 font-mono">
          {wsLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
          ) : (
            workspace?.rootPath || 'Not configured'
          )}
        </div>
      </div>

      {/* Additional paths */}
      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">Additional Paths</label>
        <div className="space-y-2">
          {workspace?.additionalPaths.length === 0 && (
            <p className="text-xs text-gray-400 py-2">No additional paths configured.</p>
          )}
          {workspace?.additionalPaths.map((path, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <span className="flex-1 text-sm font-mono text-gray-700 dark:text-gray-300">{path}</span>
              <button
                onClick={() => handleRemovePath(i)}
                disabled={saving}
                className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
                title="Remove path"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Add new path */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddPath()}
          placeholder="/path/to/directory"
          className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono"
        />
        <button
          onClick={handleAddPath}
          disabled={!newPath.trim() || validating || saving}
          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
        >
          {validating || saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Add
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-sm text-red-600">
          <XCircle className="w-4 h-4" />
          {error}
        </div>
      )}
    </div>
  );
}

function CLIIntegrationsSection() {
  const { data: ghStatus, isLoading: ghLoading, refetch: refetchGh } = useQuery({
    queryKey: ['github-status'],
    queryFn: async () => {
      try {
        const skills = await api.get<{ skills: { name: string; enabled: boolean }[] }>('/skills');
        const ghSkill = skills?.skills?.find((s) => s.name === 'github');
        return { available: !!ghSkill?.enabled, configured: !!ghSkill?.enabled };
      } catch {
        return { available: false, configured: false };
      }
    },
  });

  const { data: glStatus, isLoading: glLoading, refetch: refetchGl } = useQuery({
    queryKey: ['gitlab-status'],
    queryFn: async () => {
      try {
        const skills = await api.get<{ skills: { name: string; enabled: boolean }[] }>('/skills');
        const glSkill = skills?.skills?.find((s) => s.name === 'gitlab');
        return { available: !!glSkill?.enabled, configured: !!glSkill?.enabled };
      } catch {
        return { available: false, configured: false };
      }
    },
  });

  const cliTools = [
    {
      name: 'GitHub',
      description: 'Manage repos, issues, PRs, and workflows via gh CLI',
      status: ghStatus,
      loading: ghLoading,
      refetch: refetchGh,
      setupHint: 'Install gh CLI and run: gh auth login',
    },
    {
      name: 'GitLab',
      description: 'Manage projects, issues, MRs, and pipelines via glab CLI',
      status: glStatus,
      loading: glLoading,
      refetch: refetchGl,
      setupHint: 'Install glab CLI and run: glab auth login',
    },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">CLI Integrations</h3>
      <p className="text-xs text-gray-500 mb-3">
        These integrations use locally installed CLI tools. Authenticate via the CLI directly.
      </p>
      <div className="space-y-3">
        {cliTools.map((tool) => (
          <div
            key={tool.name}
            className="flex items-center justify-between p-3 border border-gray-200 dark:border-gray-700 rounded-lg"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-sm text-gray-900 dark:text-white">{tool.name}</h4>
                {tool.loading ? (
                  <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
                ) : (
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      tool.status?.configured
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {tool.status?.configured ? 'Available' : 'Not configured'}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
              {!tool.status?.configured && !tool.loading && (
                <p className="text-xs text-gray-400 mt-1 font-mono">{tool.setupHint}</p>
              )}
            </div>
            <button
              onClick={() => tool.refetch()}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OAuthIntegrationsSection() {
  const queryClient = useQueryClient();

  const providers = [
    {
      id: 'google',
      name: 'Google Workspace',
      description: 'Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks',
      scopes: 'email, calendar, drive, contacts, tasks',
    },
    {
      id: 'microsoft',
      name: 'Microsoft 365',
      description: 'Outlook Mail, Calendar, OneDrive, To Do, Contacts',
      scopes: 'mail, calendar, files, tasks, contacts',
    },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">OAuth Integrations</h3>
      <p className="text-xs text-gray-500 mb-3">
        Connect your accounts to let the agent access your email, calendar, and files.
      </p>
      <div className="space-y-3">
        {providers.map((provider) => (
          <OAuthProviderCard key={provider.id} provider={provider} queryClient={queryClient} />
        ))}
      </div>
    </div>
  );
}

const OAUTH_SETUP_LABELS: Record<string, string> = {
  google: 'Google OAuth Credentials',
  microsoft: 'Microsoft OAuth Credentials',
};

function OAuthProviderCard({
  provider,
  queryClient,
}: {
  provider: { id: string; name: string; description: string; scopes: string };
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['oauth-status', provider.id],
    queryFn: async () => {
      try {
        return await api.get<OAuthStatus>(`/auth/oauth/${provider.id}/status`);
      } catch {
        return { connected: false, provider: provider.id } as OAuthStatus;
      }
    },
  });

  const handleConnect = async () => {
    setConnecting(true);
    setError('');
    try {
      const { url } = await api.get<{ url: string }>(`/auth/oauth/${provider.id}/authorize`);
      const popup = window.open(url, 'oauth', 'width=600,height=700,left=200,top=100');

      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_callback') {
          window.removeEventListener('message', handler);
          queryClient.invalidateQueries({ queryKey: ['oauth-status', provider.id] });
          setConnecting(false);
        }
      };
      window.addEventListener('message', handler);

      // Fallback: if popup is closed without postMessage
      const check = setInterval(() => {
        if (popup?.closed) {
          clearInterval(check);
          window.removeEventListener('message', handler);
          queryClient.invalidateQueries({ queryKey: ['oauth-status', provider.id] });
          setConnecting(false);
        }
      }, 1000);
    } catch (err) {
      setError((err as Error).message);
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError('');
    try {
      await api.post(`/auth/oauth/${provider.id}/disconnect`);
      queryClient.invalidateQueries({ queryKey: ['oauth-status', provider.id] });
    } catch (err) {
      setError((err as Error).message);
    }
    setDisconnecting(false);
  };

  const setupLabel = OAUTH_SETUP_LABELS[provider.id] || provider.name;

  return (
    <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h4 className="font-medium text-sm text-gray-900 dark:text-white">{provider.name}</h4>
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
          ) : (
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                status?.connected
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {status?.connected ? 'Connected' : 'Not connected'}
            </span>
          )}
        </div>
        {status?.connected ? (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-3 py-1.5 text-xs border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {connecting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <ExternalLink className="w-3 h-3" />
            )}
            Connect
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500">{provider.description}</p>
      {status?.connected && status.email && (
        <p className="text-xs text-gray-400 mt-1">
          Connected as: <span className="text-gray-600 dark:text-gray-300">{status.email}</span>
        </p>
      )}
      {error && (
        <div className="mt-2 p-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            OAuth credentials not found. Add your Client ID and Client Secret under
            <span className="font-semibold"> General &gt; {setupLabel}</span>, then try connecting again.
          </p>
        </div>
      )}
    </div>
  );
}

function ChannelsTab() {
  const [linkCode, setLinkCode] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkResult, setLinkResult] = useState<{ success: boolean; error?: string } | null>(null);
  const queryClient = useQueryClient();

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<UserProfile>('/auth/me'),
  });

  const bindings = profile?.channelBindings || [];

  const handleLink = async () => {
    if (linkCode.length !== 6) return;
    setLinking(true);
    setLinkResult(null);

    try {
      const res = await api.post<{ success?: boolean; error?: string }>('/auth/link', {
        code: linkCode.toUpperCase(),
      });

      if (res.error) {
        setLinkResult({ success: false, error: res.error });
      } else {
        setLinkResult({ success: true });
        setLinkCode('');
        queryClient.invalidateQueries({ queryKey: ['profile'] });
      }
    } catch (err) {
      setLinkResult({ success: false, error: (err as Error).message });
    }

    setLinking(false);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Channel Linking</h2>

      {/* Link Code Input */}
      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h3 className="font-medium text-blue-900 dark:text-blue-200">Link a Channel</h3>
        </div>
        <p className="text-sm text-blue-700 dark:text-blue-300 mb-3">
          To link your Telegram or Slack account, send <code className="font-mono bg-blue-100 dark:bg-blue-900/40 px-1 rounded">/link</code> to the bot,
          then enter the 6-character code below.
        </p>

        <div className="flex gap-2">
          <input
            type="text"
            value={linkCode}
            onChange={(e) => setLinkCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="ABC123"
            maxLength={6}
            className="flex-1 px-3 py-2 bg-white dark:bg-gray-700 border border-blue-200 dark:border-blue-700 rounded-lg text-sm font-mono text-center text-lg tracking-widest focus:ring-2 focus:ring-blue-500 dark:text-white uppercase"
          />
          <button
            onClick={handleLink}
            disabled={linking || linkCode.length !== 6}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {linking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            Link
          </button>
        </div>

        {linkResult && (
          <div
            className={`mt-2 flex items-center gap-1.5 text-sm ${
              linkResult.success ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {linkResult.success ? (
              <>
                <CheckCircle className="w-4 h-4" />
                Account linked successfully!
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4" />
                {linkResult.error}
              </>
            )}
          </div>
        )}
      </div>

      {/* Linked Accounts */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Linked Accounts</h3>
        <div className="space-y-2">
          {bindings.length === 0 ? (
            <p className="text-sm text-gray-400 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-center">
              No channels linked yet. Use /link in Telegram or Slack to get started.
            </p>
          ) : (
            bindings.map((binding, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">
                    {binding.channelType === 'telegram'
                      ? '📱'
                      : binding.channelType === 'slack'
                      ? '💬'
                      : binding.channelType === 'teams'
                      ? '🏢'
                      : '🌐'}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white capitalize">
                      {binding.channelType}
                    </p>
                    <p className="text-xs text-gray-400">
                      {binding.channelUserName || binding.channelUserId}
                    </p>
                  </div>
                </div>
                <span
                  className={`px-2 py-0.5 text-xs rounded-full ${
                    binding.isVerified
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                      : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                  }`}
                >
                  {binding.isVerified ? 'Verified' : 'Pending'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Channel Status */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Available Channels</h3>
        <ChannelStatusList />
      </div>
    </div>
  );
}

function ChannelStatusList() {
  const { data: channelData } = useQuery({
    queryKey: ['channelStatus'],
    queryFn: async () => {
      try {
        return await api.get<{ channels: { type: string; name: string; connected: boolean }[] }>('/health/channels');
      } catch {
        return null;
      }
    },
  });

  const knownChannels = [
    { type: 'telegram', label: 'Telegram' },
    { type: 'slack', label: 'Slack' },
    { type: 'teams', label: 'Microsoft Teams' },
    { type: 'webchat', label: 'Web Chat' },
  ];

  const registeredTypes = new Set(channelData?.channels?.map((c) => c.type) || []);

  return (
    <div className="space-y-2">
      {knownChannels.map((ch) => {
        const registered = registeredTypes.has(ch.type);
        const channelInfo = channelData?.channels?.find((c) => c.type === ch.type);
        const connected = channelInfo?.connected || false;

        return (
          <div
            key={ch.type}
            className="flex items-center justify-between p-3 border border-gray-200 dark:border-gray-700 rounded-lg"
          >
            <h4 className="font-medium text-gray-900 dark:text-white">{ch.label}</h4>
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                connected
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : registered
                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {connected ? 'Connected' : registered ? 'Registered' : 'Not configured'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SecurityTab() {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<UserProfile>('/auth/me'),
  });

  const [setupData, setSetupData] = useState<{ qrCode?: string; secret?: string; backupCodes?: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSetup = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.post<{ qrCode: string; secret: string; backupCodes: string[] }>('/auth/totp/setup');
      setSetupData(data);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  const handleVerify = async () => {
    if (verifyCode.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/totp/enable', { code: verifyCode });
      setSetupData(null);
      setVerifyCode('');
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  const handleDisable = async () => {
    if (disableCode.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/totp/disable', { code: disableCode });
      setDisableCode('');
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Security</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <div>
            <h3 className="font-medium text-gray-900 dark:text-white">Two-Factor Authentication (TOTP)</h3>
            <p className="text-sm text-gray-500">
              {profile?.totpEnabled
                ? 'Your account is protected with 2FA'
                : 'Add an extra layer of security'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                profile?.totpEnabled
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {profile?.totpEnabled ? 'Enabled' : 'Disabled'}
            </span>
            {!profile?.totpEnabled && !setupData && (
              <button
                onClick={handleSetup}
                disabled={loading}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? 'Setting up...' : 'Enable 2FA'}
              </button>
            )}
          </div>
        </div>

        {/* TOTP Setup Flow */}
        {setupData && (
          <div className="p-4 border border-blue-200 dark:border-blue-800 rounded-lg space-y-4">
            <h4 className="font-medium text-gray-900 dark:text-white">Scan this QR code with your authenticator app</h4>
            {setupData.qrCode && (
              <div className="flex justify-center p-4 bg-white rounded-lg">
                <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 mb-1">Or enter this secret manually:</p>
              <code className="block px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded text-sm font-mono break-all dark:text-white">
                {setupData.secret}
              </code>
            </div>
            {setupData.backupCodes && setupData.backupCodes.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Save these backup codes somewhere safe:</p>
                <div className="grid grid-cols-2 gap-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {setupData.backupCodes.map((code, i) => (
                    <span key={i} className="dark:text-white">{code}</span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Enter 6-digit code to verify
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center font-mono text-lg tracking-widest"
                />
                <button
                  onClick={handleVerify}
                  disabled={loading || verifyCode.length !== 6}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  Verify
                </button>
              </div>
            </div>
            <button
              onClick={() => { setSetupData(null); setVerifyCode(''); }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Disable 2FA */}
        {profile?.totpEnabled && (
          <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
            <h4 className="font-medium text-gray-900 dark:text-white mb-2">Disable 2FA</h4>
            <div className="flex gap-2">
              <input
                type="text"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter TOTP code"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono"
              />
              <button
                onClick={handleDisable}
                disabled={loading || disableCode.length !== 6}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                Disable
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            Security keys and session tokens are managed server-side. Contact an admin for password resets.
          </p>
        </div>
      </div>
    </div>
  );
}

function NotificationsTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Notifications</h2>

      <div className="space-y-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Agent completion notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Permission request notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" defaultChecked className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Pipeline approval notifications</span>
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="w-4 h-4 rounded" />
          <span className="text-gray-700 dark:text-gray-300">Error notifications</span>
        </label>
      </div>
    </div>
  );
}
