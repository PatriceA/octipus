'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Settings,
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
  ArrowRight,
  KeyRound,
  Shield,
  Sliders,
  Save,
  RotateCcw,
  Eye,
  EyeOff,
} from 'lucide-react';
import Link from 'next/link';
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
    { id: 'configuration', label: 'Configuration', icon: Sliders },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'channels', label: 'Channels', icon: MessageSquare },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'notifications', label: 'Notifications', icon: Bell },
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <Settings className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure your assistant</p>
        </div>
      </div>

      <div className="flex gap-6">
        <div className="w-48 space-y-0.5 shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-400'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-6">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'configuration' && <ConfigurationTab />}
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">General Settings</h2>

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
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl text-sm dark:text-gray-200"
            />
          </div>
          {profile?.email && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email</label>
              <input
                type="text"
                value={profile.email}
                readOnly
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl text-sm dark:text-gray-200"
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

      {/* Secrets redirect */}
      <Link
        href="/secrets"
        className="flex items-center justify-between p-4 bg-primary-50 dark:bg-primary-950/30 rounded-xl ring-1 ring-primary-200/60 dark:ring-primary-800/40 hover:bg-primary-100/80 dark:hover:bg-primary-950/50 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <KeyRound className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          <div>
            <p className="text-sm font-medium text-primary-900 dark:text-primary-300">Secrets & Credentials</p>
            <p className="text-xs text-primary-700/70 dark:text-primary-400/60">Manage API keys, OAuth credentials, and other secrets</p>
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-primary-400 group-hover:translate-x-0.5 transition-transform" />
      </Link>
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Integrations</h2>
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
            <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />
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
            <p className="text-xs text-gray-500 py-2">No additional paths configured.</p>
          )}
          {workspace?.additionalPaths.map((path, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <span className="flex-1 text-sm font-mono text-gray-700 dark:text-gray-300">{path}</span>
              <button
                onClick={() => handleRemovePath(i)}
                disabled={saving}
                className="p-1 text-gray-500 hover:text-red-500 disabled:opacity-50"
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
          className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm font-mono"
        />
        <button
          onClick={handleAddPath}
          disabled={!newPath.trim() || validating || saving}
          className="px-3 py-1.5 text-xs bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center gap-1"
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
        const skills = await api.get<{ skills: { id: string; isInitialized: boolean }[] }>('/skills');
        const ghSkill = skills?.skills?.find((s) => s.id === 'github');
        return { available: !!ghSkill, configured: !!ghSkill?.isInitialized };
      } catch {
        return { available: false, configured: false };
      }
    },
  });

  const { data: glStatus, isLoading: glLoading, refetch: refetchGl } = useQuery({
    queryKey: ['gitlab-status'],
    queryFn: async () => {
      try {
        const skills = await api.get<{ skills: { id: string; isInitialized: boolean }[] }>('/skills');
        const glSkill = skills?.skills?.find((s) => s.id === 'gitlab');
        return { available: !!glSkill, configured: !!glSkill?.isInitialized };
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
            className="flex items-center justify-between p-3 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100">{tool.name}</h4>
                {tool.loading ? (
                  <Loader2 className="w-3 h-3 animate-spin text-gray-500" />
                ) : (
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      tool.status?.configured
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : tool.status?.available
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {tool.status?.configured ? 'Available' : tool.status?.available ? 'Detected' : 'Not found'}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
              {!tool.status?.available && !tool.loading && (
                <p className="text-xs text-gray-500 mt-1 font-mono">{tool.setupHint}</p>
              )}
            </div>
            <button
              onClick={() => tool.refetch()}
              className="p-1.5 text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
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

  return (
    <div className="p-4 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100">{provider.name}</h4>
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-gray-500" />
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
            className="px-3 py-1.5 text-xs bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center gap-1"
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
        <p className="text-xs text-gray-500 mt-1">
          Connected as: <span className="text-gray-600 dark:text-gray-300">{status.email}</span>
        </p>
      )}
      {error && (
        <div className="mt-2 p-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            {error.includes('not configured') ? (
              <>Add your Client ID and Client Secret on the <Link href="/secrets" className="font-semibold underline hover:text-amber-900 dark:hover:text-amber-100">Secrets page</Link>, then try connecting again.</>
            ) : error}
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Channel Linking</h2>

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
            className="flex-1 px-3 py-2 bg-white dark:bg-gray-700 border border-blue-200 dark:border-blue-700 rounded-lg text-sm font-mono text-center text-lg tracking-widest focus:ring-2 focus:ring-blue-500 dark:text-gray-100 uppercase"
          />
          <button
            onClick={handleLink}
            disabled={linking || linkCode.length !== 6}
            className="px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center gap-2"
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
            <p className="text-sm text-gray-500 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-center">
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
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {binding.channelType}
                    </p>
                    <p className="text-xs text-gray-500">
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
            className="flex items-center justify-between p-3 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl"
          >
            <h4 className="font-medium text-gray-900 dark:text-gray-100">{ch.label}</h4>
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Security</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">Two-Factor Authentication (TOTP)</h3>
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
                className="px-3 py-1.5 text-xs bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {loading ? 'Setting up...' : 'Enable 2FA'}
              </button>
            )}
          </div>
        </div>

        {/* TOTP Setup Flow */}
        {setupData && (
          <div className="p-4 border border-blue-200 dark:border-blue-800 rounded-lg space-y-4">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">Scan this QR code with your authenticator app</h4>
            {setupData.qrCode && (
              <div className="flex justify-center p-4 bg-white rounded-lg">
                <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 mb-1">Or enter this secret manually:</p>
              <code className="block px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded text-sm font-mono break-all dark:text-gray-100">
                {setupData.secret}
              </code>
            </div>
            {setupData.backupCodes && setupData.backupCodes.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Save these backup codes somewhere safe:</p>
                <div className="grid grid-cols-2 gap-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {setupData.backupCodes.map((code, i) => (
                    <span key={i} className="dark:text-gray-100">{code}</span>
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
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-center font-mono text-lg tracking-widest"
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
          <div className="p-4 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl">
            <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">Disable 2FA</h4>
            <div className="flex gap-2">
              <input
                type="text"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter TOTP code"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono"
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

// ─── Configuration Tab (runtime settings from DB) ───

interface SettingItem {
  key: string;
  value: unknown;
  valueType: string;
  description: string;
  defaultValue: unknown;
  isSecret: boolean;
  category: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  litellm: 'LiteLLM / LLM Proxy',
  ollama: 'Ollama',
  channels: 'Channels',
  agent: 'Agent',
  orchestrator: 'Orchestrator',
  workspace: 'Workspace',
  logging: 'Logging',
  integrations: 'Integrations',
  voice: 'Voice',
  api: 'API',
  security: 'Security',
};

function ConfigurationTab() {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Record<string, SettingItem[]>; categories: string[] }>('/settings'),
  });

  const handleSave = async (key: string, value: unknown) => {
    setSaving(key);
    setError('');
    try {
      await api.put(`/settings/${encodeURIComponent(key)}`, { value });
      setSaved(key);
      setTimeout(() => setSaved(null), 2000);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(`Failed to save ${key}: ${(err as Error).message}`);
    }
    setSaving(null);
  };

  const handleReset = async (key: string) => {
    setSaving(key);
    setError('');
    try {
      await api.post(`/settings/${encodeURIComponent(key)}/reset`);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(`Failed to reset ${key}: ${(err as Error).message}`);
    }
    setSaving(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const categories = data?.categories || [];
  const settings = data?.settings || {};

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">System Configuration</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Runtime settings. Changes take effect immediately without restart.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {categories.map((category) => (
        <SettingsCategorySection
          key={category}
          category={category}
          label={CATEGORY_LABELS[category] || category}
          settings={settings[category] || []}
          onSave={handleSave}
          onReset={handleReset}
          saving={saving}
          saved={saved}
        />
      ))}
    </div>
  );
}

function SettingsCategorySection({
  category,
  label,
  settings,
  onSave,
  onReset,
  saving,
  saved,
}: {
  category: string;
  label: string;
  settings: SettingItem[];
  onSave: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
  saving: string | null;
  saved: string | null;
}) {
  const [localValues, setLocalValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const initial: Record<string, unknown> = {};
    for (const s of settings) {
      initial[s.key] = s.value;
    }
    setLocalValues(initial);
  }, [settings]);

  const getLocalValue = (key: string) => {
    return localValues[key] ?? '';
  };

  const setLocalValue = (key: string, value: unknown) => {
    setLocalValues(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
        {label}
      </h3>
      <div className="space-y-2">
        {settings.map((setting) => (
          <SettingField
            key={setting.key}
            setting={setting}
            value={getLocalValue(setting.key)}
            onChange={(val) => setLocalValue(setting.key, val)}
            onSave={() => onSave(setting.key, localValues[setting.key])}
            onReset={() => onReset(setting.key)}
            isSaving={saving === setting.key}
            isSaved={saved === setting.key}
          />
        ))}
      </div>
    </div>
  );
}

function SettingField({
  setting,
  value,
  onChange,
  onSave,
  onReset,
  isSaving,
  isSaved,
}: {
  setting: SettingItem;
  value: unknown;
  onChange: (value: unknown) => void;
  onSave: () => void;
  onReset: () => void;
  isSaving: boolean;
  isSaved: boolean;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const shortKey = setting.key.split('.').pop() || setting.key;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSave();
  };

  const inputClasses = 'w-full px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{shortKey}</label>
          {setting.isSecret && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              secret
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-2">{setting.description}</p>

        {setting.valueType === 'boolean' ? (
          <button
            onClick={() => { onChange(!(value as boolean)); setTimeout(onSave, 0); }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              value ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              value ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        ) : setting.isSecret ? (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showSecret ? 'text' : 'password'}
                value={String(value || '')}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Enter ${shortKey}...`}
                className={inputClasses}
              />
              <button
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        ) : setting.valueType === 'number' ? (
          <input
            type="number"
            value={String(value ?? '')}
            onChange={(e) => onChange(Number(e.target.value))}
            onKeyDown={handleKeyDown}
            className={inputClasses}
          />
        ) : setting.valueType === 'string_array' ? (
          <input
            type="text"
            value={Array.isArray(value) ? (value as string[]).join(', ') : String(value || '')}
            onChange={(e) => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            onKeyDown={handleKeyDown}
            placeholder="value1, value2, ..."
            className={inputClasses}
          />
        ) : (
          <input
            type="text"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className={inputClasses}
          />
        )}
      </div>

      <div className="flex items-center gap-1 pt-7 shrink-0">
        {setting.valueType !== 'boolean' && (
          <button
            onClick={onSave}
            disabled={isSaving}
            className="p-1.5 text-gray-400 hover:text-primary-600 disabled:opacity-50"
            title="Save"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isSaved ? (
              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        <button
          onClick={onReset}
          disabled={isSaving}
          className="p-1.5 text-gray-400 hover:text-amber-600 disabled:opacity-50"
          title="Reset to default"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function NotificationsTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Notifications</h2>

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
