'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  Link2,
  CheckCircle,
  XCircle,
  Send,
  Settings2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { UserProfile } from '@/lib/types/settings';
import {
  type SettingItem,
  useSettingActions,
  SettingsGroup,
  SecretsRedirectBanner,
} from './setting-field';

export function ChannelsTab() {
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Channels</h2>

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
                      ? '\u{1F4F1}'
                      : binding.channelType === 'slack'
                      ? '\u{1F4AC}'
                      : binding.channelType === 'teams'
                      ? '\u{1F3E2}'
                      : '\u{1F310}'}
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

      {/* Channel Configuration */}
      <ChannelConfigSection />
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

/** Channel-specific settings from the settings registry */
const CHANNEL_GROUPS = [
  {
    id: 'telegram',
    label: 'Telegram',
    prefix: 'telegram.',
  },
  {
    id: 'slack',
    label: 'Slack',
    prefix: 'slack.',
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    prefix: 'teams.',
  },
];

function ChannelConfigSection() {
  const { saving, saved, error, handleSave, handleReset } = useSettingActions();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Record<string, SettingItem[]>; categories: string[] }>('/settings'),
  });

  const channelSettings = data?.settings?.['channels'] || [];
  if (channelSettings.length === 0 && !isLoading) return null;

  const hasSecrets = channelSettings.some(s => s.isSecret);

  const toggle = (id: string) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 bg-gray-50/50 dark:bg-gray-800/50 border-b border-gray-200/60 dark:border-gray-700/60">
        <Settings2 className="w-5 h-5 text-gray-500 dark:text-gray-400" />
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Channel Configuration</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Bot tokens, webhook URLs, and polling settings</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="p-5 space-y-3">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {hasSecrets && <SecretsRedirectBanner />}

          {CHANNEL_GROUPS.map((group) => {
            const items = channelSettings.filter(
              s => s.key.startsWith(group.prefix) && !s.isSecret
            );
            if (items.length === 0) return null;
            const isOpen = expanded[group.id] ?? false;

            return (
              <div key={group.id} className="border border-gray-200/60 dark:border-gray-700/50 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggle(group.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{group.label}</span>
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  )}
                </button>
                {isOpen && (
                  <div className="border-t border-gray-200/60 dark:border-gray-700/50 px-2 py-2">
                    <SettingsGroup
                      settings={items}
                      onSave={handleSave}
                      onReset={handleReset}
                      saving={saving}
                      saved={saved}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
