'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Link2,
  Loader2,
  Send,
  Settings2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { UserProfile } from '@/lib/types/settings';
import {
  SecretsRedirectBanner,
  type SettingItem,
  SettingsGroup,
  useSettingActions,
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
      <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">Channels</h2>

      {/* Link Code Input */}
      <div className="p-6 bg-primary/10 rounded-xs">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-5 h-5 text-primary" />
          <h3 className="font-medium text-on-surface">Link a Channel</h3>
        </div>
        <p className="text-sm text-on-surface-variant mb-3">
          To link your Telegram, Slack, or WhatsApp account, send <code className="font-mono bg-primary/15 px-1 rounded text-primary">/link</code> to the bot,
          then enter the 6-character code below.
        </p>

        <div className="flex gap-2">
          <input
            type="text"
            value={linkCode}
            onChange={(e) => setLinkCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="ABC123"
            maxLength={6}
            className="flex-1 bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface font-mono text-center text-lg tracking-widest focus:ring-1 focus:ring-primary uppercase"
          />
          <button
            onClick={handleLink}
            disabled={linking || linkCode.length !== 6}
            className="px-4 py-2 bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container disabled:opacity-50 flex items-center gap-2"
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
              linkResult.success ? 'text-tertiary' : 'text-error'
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
        <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-2">Linked Accounts</h3>
        <div className="space-y-2">
          {bindings.length === 0 ? (
            <p className="text-sm text-on-surface-variant p-4 bg-surface-container-low rounded-lg text-center">
              No channels linked yet. Use /link in Telegram or Slack to get started.
            </p>
          ) : (
            bindings.map((binding, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 bg-surface-container-low rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">
                    {binding.channelType === 'telegram'
                      ? '\u{1F4F1}'
                      : binding.channelType === 'slack'
                      ? '\u{1F4AC}'
                      : binding.channelType === 'teams'
                      ? '\u{1F3E2}'
                      : binding.channelType === 'whatsapp'
                      ? '\u{1F4F2}'
                      : '\u{1F310}'}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-on-surface capitalize">
                      {binding.channelType}
                    </p>
                    <p className="text-xs text-on-surface-variant">
                      {binding.channelUserName || binding.channelUserId}
                    </p>
                  </div>
                </div>
                <span
                  className={`px-2 py-0.5 text-xs rounded-full ${
                    binding.isVerified
                      ? 'bg-tertiary-container/60 text-tertiary'
                      : 'bg-warning-container/60 text-warning'
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
        <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-2">Available Channels</h3>
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
    { type: 'whatsapp', label: 'WhatsApp' },
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
            className="flex items-center justify-between p-3 bg-surface-container-low rounded-xs"
          >
            <h4 className="font-medium text-on-surface">{ch.label}</h4>
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                connected
                  ? 'bg-tertiary-container/60 text-tertiary'
                  : registered
                  ? 'bg-warning-container/60 text-warning'
                  : 'bg-surface-container-high text-on-surface-variant'
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
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    prefix: 'whatsapp.',
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
    <div className="bg-surface-container-low rounded-xs overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/10">
        <Settings2 className="w-5 h-5 text-on-surface-variant" />
        <div>
          <h3 className="text-base font-semibold text-on-surface">Channel Configuration</h3>
          <p className="text-xs text-on-surface-variant">Bot tokens, webhook URLs, and polling settings</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-on-surface-variant" />
        </div>
      ) : (
        <div className="p-5 space-y-3">
          {error && (
            <div className="p-3 bg-error-dim/10 border border-error-dim/20 rounded-lg">
              <p className="text-sm text-error">{error}</p>
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
              <div key={group.id} className="border border-outline-variant/10 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggle(group.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-container-high transition-colors"
                >
                  <span className="text-sm font-medium text-on-surface">{group.label}</span>
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-on-surface-variant" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-on-surface-variant" />
                  )}
                </button>
                {isOpen && (
                  <div className="border-t border-outline-variant/10 px-2 py-2">
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
