'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useWorkspaceId } from '@/lib/workspace-context';
import { SecretsRedirectBanner, type SettingItem } from '../setting-field';
import { SelectSetting, type SettingSaver, settingValue, TextAreaSetting, TextSetting, ToggleSetting } from './setting-controls';
import { Busy, errorText, InlineError, primaryBtn, quietBtn, Section, SubHeading } from './ui';

const PROVIDERS = [
  { value: 'disabled', label: 'Off' },
  { value: 'twilio', label: 'Twilio' },
  { value: 'telnyx', label: 'Telnyx' },
  { value: 'plivo', label: 'Plivo' },
];
const INBOUND = [
  { value: 'disabled', label: 'Off — nobody can call in' },
  { value: 'allowlist', label: 'Only the numbers listed below' },
  { value: 'open', label: 'Anyone' },
];
/** The secrets each provider's account is read from. */
const PROVIDER_SECRETS: Record<string, Array<{ name: string; label: string; note?: string }>> = {
  twilio: [{ name: 'twilio_account_sid', label: 'Account SID' }, { name: 'twilio_auth_token', label: 'Auth Token' }],
  telnyx: [
    { name: 'telnyx_api_key', label: 'API Key' },
    { name: 'telnyx_connection_id', label: 'Connection ID' },
    // Telnyx signs its webhooks with Ed25519; without the account's public key every incoming call is refused.
    { name: 'telnyx_public_key', label: 'Public Key', note: 'Required for incoming calls: without it, every call Telnyx announces is refused.' },
  ],
  plivo: [{ name: 'plivo_auth_id', label: 'Auth ID' }, { name: 'plivo_auth_token', label: 'Auth Token' }],
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Phone calls through a telephony provider: the account, the numbers, who may call in. */
export function CallsSection({ settings, saver }: { settings: SettingItem[]; saver: SettingSaver }) {
  const workspaceId = useWorkspaceId();
  const provider = text(settingValue(settings, 'voice.telephonyProvider')) || 'disabled';
  const providerName = PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
  const publicUrl = text(settingValue(settings, 'voice.publicUrl'));
  const inbound = text(settingValue(settings, 'voice.inboundPolicy')) || 'disabled';
  const allowFrom = settingValue(settings, 'voice.inboundAllowFrom');
  const on = provider !== 'disabled';
  const secrets = PROVIDER_SECRETS[provider];
  const webhookUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/api/voice/webhook/${provider}` : '';

  const { data: vault } = useQuery({
    queryKey: ['vault', workspaceId],
    queryFn: () => api.get<{ credentials?: Array<{ name: string }> }>('/vault'),
    enabled: on,
  });
  const stored = new Set((vault?.credentials ?? []).map((credential) => credential.name));

  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<{ healthy: boolean; message: string } | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const testConnection = async () => {
    setTesting(true);
    setHealth(null);
    try {
      const result = await api.get<{ configured?: boolean; provider?: string | null; healthy?: boolean; error?: string }>('/voice/telephony/health');
      if (!result.configured) setHealth({ healthy: false, message: `${providerName} is not set up yet: its credentials are missing under Secrets.` });
      else if (!result.healthy) setHealth({ healthy: false, message: result.error || `${result.provider ?? providerName} did not accept the credentials.` });
      else setHealth({ healthy: true, message: `Connected to ${result.provider ?? providerName}.` });
    } catch (err) {
      setHealth({ healthy: false, message: errorText(err) });
    } finally {
      setTesting(false);
    }
  };
  const copyWebhook = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(webhookUrl);
    } catch (err) {
      setCopyError(`Could not copy: ${errorText(err)}. Select the address and copy it by hand.`);
    }
  };

  return (
    <Section title="Calls" description="Make and receive phone calls through a telephony provider." testId="voice-calls">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectSetting
          settingKey="voice.telephonyProvider"
          label="Phone provider"
          hint="The service that connects the calls. Its account details are kept under Secrets."
          value={provider}
          options={PROVIDERS}
          saver={saver}
        />
        <TextSetting
          settingKey="voice.phoneNumber"
          label="Your number"
          hint="The number calls are made from, with the country code (+14155551234). It must be a number on your provider account, not the one you are calling. Empty: the number stored under Secrets is used."
          value={text(settingValue(settings, 'voice.phoneNumber'))}
          placeholder="+14155551234"
          saver={saver}
          toValue={(typed) => typed.trim() || null}
        />
        <TextSetting
          settingKey="voice.publicUrl"
          label="Public address of this server"
          hint="Where the provider reaches this server from the internet, without a path (https://assistant.example.com)."
          value={publicUrl}
          placeholder="https://assistant.example.com"
          saver={saver}
          toValue={(typed) => typed.trim() || null}
        />
        <SelectSetting
          settingKey="voice.inboundPolicy"
          label="Incoming calls"
          hint="Who may call your number and reach the assistant."
          value={inbound}
          options={INBOUND}
          saver={saver}
        />
        <TextSetting
          settingKey="voice.inboundAllowFrom"
          label="Numbers that may call in"
          hint="With the country code, separated by commas. Used when incoming calls are limited to listed numbers."
          value={Array.isArray(allowFrom) ? allowFrom.filter((n): n is string => typeof n === 'string').join(', ') : ''}
          placeholder="+14155551234, +442071234567"
          saver={saver}
          toValue={(typed) => typed.split(',').map((n) => n.trim()).filter(Boolean)}
        />
      </div>
      <ToggleSetting
        settingKey="voice.streaming"
        label="Live audio on calls"
        hint="The call is heard and answered as it happens: replies come sooner and the caller can interrupt. It needs the public address above. Off: caller and assistant take turns."
        checked={settingValue(settings, 'voice.streaming') === true}
        saver={saver}
      />

      <TextAreaSetting
        settingKey="voice.expertPrompt"
        label="How Octipus behaves on calls"
        hint="Who it is on the phone, what it may and may not do, how it greets a caller. Empty: a general assistant that keeps its answers short."
        value={text(settingValue(settings, 'voice.expertPrompt'))}
        placeholder="You answer the phone for a small bakery. Take orders for pickup, tell callers the opening hours, and never promise a delivery."
        saver={saver}
        maxLength={4000}
      />

      {on && secrets && (
        <div className="space-y-2" data-testid="call-credentials">
          <SubHeading>{providerName} account</SubHeading>
          <ul className="space-y-1.5">
            {secrets.map((secret) => (
              <li key={secret.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-on-surface-variant">
                  {secret.label} <code className="text-xs">{secret.name}</code>
                  {secret.note && <span className="block text-xs" data-testid={`secret-note-${secret.name}`}>{secret.note}</span>}
                </span>
                {stored.has(secret.name)
                  ? <span className="flex items-center gap-1 text-tertiary text-xs"><CheckCircle className="w-3 h-3" aria-hidden /> Stored</span>
                  : <span className="flex items-center gap-1 text-warning text-xs"><XCircle className="w-3 h-3" aria-hidden /> Missing</span>}
              </li>
            ))}
          </ul>
          <SecretsRedirectBanner />
        </div>
      )}

      {on && webhookUrl && (
        <div className="space-y-2">
          <SubHeading>Address to give {providerName}</SubHeading>
          <p className="text-xs text-on-surface-variant">Enter this in your {providerName} console as the address it calls when a call comes in:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-surface-container-lowest px-3 py-2 rounded-lg text-primary break-all">{webhookUrl}</code>
            <button type="button" className={quietBtn} onClick={copyWebhook}>Copy</button>
          </div>
          <InlineError message={copyError} />
        </div>
      )}

      {on && (
        <div className="space-y-2">
          <SubHeading>Connection</SubHeading>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primaryBtn} disabled={testing} onClick={testConnection}><Busy on={testing} /> Test the connection</button>
            {health?.healthy && <span className="flex items-center gap-1.5 text-sm text-tertiary" role="status"><CheckCircle className="w-4 h-4" aria-hidden /> {health.message}</span>}
          </div>
          {health && !health.healthy && <InlineError message={health.message} testId="call-health-error" />}
        </div>
      )}

      <div className="space-y-2">
        <SubHeading>Setting up calls</SubHeading>
        <ol className="text-xs text-on-surface-variant space-y-1.5 list-decimal list-inside">
          <li>Choose a phone provider above.</li>
          <li>Store its account details under <Link href="/secrets" className="text-primary hover:underline">Secrets</Link>.</li>
          <li>Enter the public address of this server (a tunnel such as ngrok or Cloudflare Tunnel works).</li>
          <li>Pick a fast chat model for calls: the Voice row on the <Link href="/topics" className="text-primary hover:underline">Topics page</Link>.</li>
          <li>Test the connection. Your number is read from the provider account when none is entered here.</li>
        </ol>
      </div>
    </Section>
  );
}
