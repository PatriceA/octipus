'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Phone,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  type SettingItem,
  useSettingActions,
  SettingsGroup,
  SecretsRedirectBanner,
} from './setting-field';

const PROVIDER_VAULT_KEYS: Record<string, { keys: string[]; labels: string[] }> = {
  twilio: {
    keys: ['twilio_account_sid', 'twilio_auth_token'],
    labels: ['Account SID', 'Auth Token'],
  },
  telnyx: {
    keys: ['telnyx_api_key', 'telnyx_connection_id'],
    labels: ['API Key', 'Connection ID'],
  },
  plivo: {
    keys: ['plivo_auth_id', 'plivo_auth_token'],
    labels: ['Auth ID', 'Auth Token'],
  },
};

export function VoiceTab() {
  const { handleSave, handleReset, saving, saved } = useSettingActions();
  const [testingHealth, setTestingHealth] = useState(false);
  const [healthResult, setHealthResult] = useState<{ healthy: boolean; error?: string; provider?: string } | null>(null);

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Record<string, SettingItem[]>; categories: string[] }>('/settings'),
  });

  const { data: vaultData } = useQuery({
    queryKey: ['vault'],
    queryFn: () => api.get<{ credentials: Array<{ name: string }> }>('/vault'),
  });

  const voiceSettings = settingsData?.settings?.voice || [];
  const currentProvider = voiceSettings.find(s => s.key === 'voice.telephonyProvider')?.value as string || 'disabled';
  const publicUrl = voiceSettings.find(s => s.key === 'voice.publicUrl')?.value as string || '';

  const existingVaultKeys = new Set((vaultData?.credentials || []).map(c => c.name));
  const providerConfig = PROVIDER_VAULT_KEYS[currentProvider];

  const testConnection = async () => {
    setTestingHealth(true);
    setHealthResult(null);
    try {
      const result = await api.get<{ configured?: boolean; provider?: string; healthy?: boolean; error?: string }>('/voice/telephony/health');
      if (!result.configured) {
        setHealthResult({ healthy: false, error: `Provider "${currentProvider}" not configured. Check vault credentials.` });
      } else if (!result.healthy) {
        setHealthResult({ healthy: false, error: result.error || `Connection to ${result.provider || currentProvider} failed. Verify credentials are correct.`, provider: result.provider });
      } else {
        setHealthResult({ healthy: true, provider: result.provider });
      }
    } catch (err) {
      const msg = (err as Error).message;
      setHealthResult({ healthy: false, error: msg.includes('401') ? 'Authentication failed — check your API credentials in the vault.' : msg });
    }
    setTestingHealth(false);
  };

  const webhookUrl = publicUrl ? `${publicUrl}/api/voice/webhook/${currentProvider}` : '';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white mb-1">Voice & Phone Calls</h2>
        <p className="text-sm text-on-surface-variant">
          Configure telephony providers for making and receiving phone calls.
        </p>
      </div>

      {/* Provider Settings */}
      {voiceSettings.length > 0 && (
        <SettingsGroup
          settings={voiceSettings}
          onSave={handleSave}
          onReset={handleReset}
          saving={saving}
          saved={saved}
        />
      )}

      {/* Credential Status */}
      {currentProvider !== 'disabled' && providerConfig && (
        <div className="bg-surface-container rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Phone className="w-4 h-4" />
            {currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1)} Credentials
          </h3>
          <p className="text-xs text-on-surface-variant">
            Store these in <a href="/secrets" className="text-primary hover:underline">Settings &gt; Secrets</a> (Vault):
          </p>
          <div className="space-y-2">
            {providerConfig.keys.map((key, i) => (
              <div key={key} className="flex items-center justify-between text-sm">
                <span className="text-on-surface-variant">{providerConfig.labels[i]} <code className="text-xs bg-[#111] px-1.5 py-0.5 rounded">{key}</code></span>
                {existingVaultKeys.has(key) ? (
                  <span className="flex items-center gap-1 text-green-400 text-xs"><CheckCircle className="w-3 h-3" /> Stored</span>
                ) : (
                  <span className="flex items-center gap-1 text-yellow-400 text-xs"><XCircle className="w-3 h-3" /> Missing</span>
                )}
              </div>
            ))}
          </div>
          <SecretsRedirectBanner />
        </div>
      )}

      {/* Webhook URL */}
      {currentProvider !== 'disabled' && publicUrl && (
        <div className="bg-surface-container rounded-xl p-4 space-y-2">
          <h3 className="text-sm font-semibold text-white">Webhook URL</h3>
          <p className="text-xs text-on-surface-variant">
            Configure this in your {currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1)} console as the voice webhook URL:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-[#111] px-3 py-2 rounded-lg text-primary break-all">
              {webhookUrl}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(webhookUrl)}
              className="px-3 py-2 text-xs bg-primary/10 text-primary rounded-lg hover:bg-primary/20"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Test Connection */}
      {currentProvider !== 'disabled' && (
        <div className="bg-surface-container rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white">Connection Test</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={testConnection}
              disabled={testingHealth}
              className="px-4 py-2 bg-primary text-[#002a6d] rounded-lg text-sm font-medium hover:bg-primary-container disabled:opacity-50"
            >
              {testingHealth ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test Connection'}
            </button>
            {healthResult && (
              <div className={`flex items-start gap-2 text-sm ${healthResult.healthy ? 'text-green-400' : 'text-red-400'}`}>
                {healthResult.healthy ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                <span className="break-all">
                  {healthResult.healthy ? `Connected to ${healthResult.provider}` : healthResult.error || 'Connection failed — unknown error'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Setup Guide */}
      <div className="bg-surface-container rounded-xl p-4 space-y-2">
        <h3 className="text-sm font-semibold text-white">Setup Guide</h3>
        <ol className="text-xs text-on-surface-variant space-y-1.5 list-decimal list-inside">
          <li>Choose a provider above (Twilio, Telnyx, or Plivo)</li>
          <li>Store the provider credentials in <a href="/secrets" className="text-primary hover:underline">Secrets (Vault)</a></li>
          <li>Set your public webhook URL (e.g., ngrok or Cloudflare Tunnel URL)</li>
          <li>Assign a fast model to the <strong>voice</strong> topic in the <a href="/models" className="text-primary hover:underline">Models</a> page</li>
          <li>Click &quot;Test Connection&quot; to verify</li>
          <li>Phone number is auto-detected from your provider account</li>
        </ol>
      </div>
    </div>
  );
}
