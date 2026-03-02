'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Settings,
  Key,
  Bell,
  MessageSquare,
  Save,
  Loader2,
  Link2,
  CheckCircle,
  XCircle,
  Send,
} from 'lucide-react';
import { api, getApiUrl, setApiUrl } from '@/lib/api';

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
  const [activeTab, setActiveTab] = useState('connection');
  const queryClient = useQueryClient();

  const tabs = [
    { id: 'connection', label: 'Connection', icon: Link2 },
    { id: 'general', label: 'General', icon: Settings },
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
          {activeTab === 'connection' && <ConnectionTab />}
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'channels' && <ChannelsTab />}
          {activeTab === 'security' && <SecurityTab />}
          {activeTab === 'notifications' && <NotificationsTab />}
        </div>
      </div>
    </div>
  );
}

function ConnectionTab() {
  const [apiUrl, setApiUrlState] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    const current = getApiUrl();
    // Show empty if using default, otherwise show the custom URL without /api suffix
    const stored = typeof window !== 'undefined' ? localStorage.getItem('assistant_api_url') : null;
    setApiUrlState(stored ? stored.replace(/\/api$/, '') : '');
  }, []);

  const handleTest = async (url?: string) => {
    const testUrl = url || apiUrl || 'http://localhost:3005';
    const fullUrl = testUrl.replace(/\/+$/, '');
    const apiEndpoint = fullUrl.endsWith('/api') ? fullUrl : `${fullUrl}/api`;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${apiEndpoint}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        setTestStatus('ok');
        setTestMessage(`Connected (${data.status || 'ok'})`);
      } else {
        setTestStatus('error');
        setTestMessage(`HTTP ${res.status}`);
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage((err as Error).name === 'AbortError' ? 'Timeout — server unreachable' : (err as Error).message);
    }
  };

  const handleSave = () => {
    if (apiUrl.trim()) {
      setApiUrl(apiUrl.trim());
    } else {
      setApiUrl(null);
    }
    // Force page reload to re-initialize all API connections
    window.location.reload();
  };

  const handleReset = () => {
    setApiUrl(null);
    setApiUrlState('');
    setTestStatus('idle');
    setTestMessage('');
    window.location.reload();
  };

  const currentUrl = getApiUrl();
  const isCustom = typeof window !== 'undefined' && !!localStorage.getItem('assistant_api_url');

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">API Connection</h2>

      <div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Set the backend API URL. Use this when accessing the assistant from another device on your local network.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Current API URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm font-mono dark:text-white">
                {currentUrl}
              </code>
              {isCustom && (
                <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 rounded-full">
                  Custom
                </span>
              )}
              {!isCustom && (
                <span className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 rounded-full">
                  Default
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Backend URL (e.g. http://192.168.1.100:3005)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => { setApiUrlState(e.target.value); setTestStatus('idle'); }}
                placeholder="http://localhost:3005"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono"
              />
              <button
                onClick={() => handleTest()}
                disabled={testStatus === 'testing'}
                className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Test'
                )}
              </button>
            </div>
          </div>

          {testStatus !== 'idle' && testStatus !== 'testing' && (
            <div className={`flex items-center gap-1.5 text-sm ${
              testStatus === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }`}>
              {testStatus === 'ok' ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              {testMessage}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              Save & Reload
            </button>
            {isCustom && (
              <button
                onClick={handleReset}
                className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Reset to Default
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          <strong>LAN access:</strong> To use the assistant from another PC, make sure the backend
          binds to <code className="font-mono bg-blue-100 dark:bg-blue-900/40 px-1 rounded">0.0.0.0</code> (set <code className="font-mono bg-blue-100 dark:bg-blue-900/40 px-1 rounded">API_HOST=0.0.0.0</code> in .env)
          and set the CORS origins to include the client&apos;s address.
        </p>
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

const PROVIDER_KEYS = [
  { provider: 'openai', label: 'OpenAI', vaultName: 'openai_api_key', envHint: 'OPENAI_API_KEY' },
  { provider: 'anthropic', label: 'Anthropic', vaultName: 'anthropic_api_key', envHint: 'ANTHROPIC_API_KEY' },
  { provider: 'gemini', label: 'Google Gemini', vaultName: 'gemini_api_key', envHint: 'GEMINI_API_KEY' },
  { provider: 'deepseek', label: 'DeepSeek', vaultName: 'deepseek_api_key', envHint: 'DEEPSEEK_API_KEY' },
];

function ProviderKeysSection() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    // Check which keys exist in the vault
    api.get<{ credentials?: { name: string }[] }>('/vault').then((data) => {
      const creds = data?.credentials ?? [];
      const s: Record<string, boolean> = {};
      for (const pk of PROVIDER_KEYS) {
        s[pk.vaultName] = creds.some((c) => c.name === pk.vaultName);
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
        description: `API key for ${vaultName.replace('_api_key', '')}`,
        tags: ['provider'],
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
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Provider API Keys</h3>
      <p className="text-xs text-gray-500 mb-3">
        Store API keys securely in the vault for direct provider access (bypasses LiteLLM).
      </p>
      <div className="space-y-3">
        {PROVIDER_KEYS.map((pk) => (
          <div key={pk.vaultName} className="flex items-center gap-2">
            <div className="w-28 text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${statuses[pk.vaultName] ? 'bg-green-500' : 'bg-gray-400'}`} />
              {pk.label}
            </div>
            <input
              type="password"
              value={keys[pk.vaultName] || ''}
              onChange={(e) => setKeys((k) => ({ ...k, [pk.vaultName]: e.target.value }))}
              placeholder={statuses[pk.vaultName] ? 'Key saved (enter to replace)' : 'sk-...'}
              className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
            <button
              onClick={() => handleSave(pk.vaultName)}
              disabled={!keys[pk.vaultName] || saving === pk.vaultName}
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving === pk.vaultName ? '...' : 'Save'}
            </button>
            {statuses[pk.vaultName] && (
              <button
                onClick={() => handleTest(pk.provider, pk.vaultName)}
                disabled={testing === pk.vaultName}
                className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {testing === pk.vaultName ? '...' : 'Test'}
              </button>
            )}
          </div>
        ))}
      </div>
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
