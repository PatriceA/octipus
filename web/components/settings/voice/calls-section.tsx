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

/** `voice.callAssistant` as typed: `+14155551234: alice, +442071234567: bob`. */
function assistantText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((entry): entry is { number: string; user: string } => !!entry && typeof entry.number === 'string' && typeof entry.user === 'string')
    .map((entry) => `${entry.number}: ${entry.user}`)
    .join(', ');
}

/** What was typed → the setting's entries. A piece without a number and a user is dropped. */
function assistantEntries(typed: string): Array<{ number: string; user: string }> {
  return typed.split(',').flatMap((piece) => {
    const match = /^\s*([+\d][\d\s()+-]*?)\s*:\s*(\S+)\s*$/.exec(piece);
    return match ? [{ number: match[1].replace(/[\s()-]/g, ''), user: match[2] }] : [];
  });
}

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
        hint="The call is heard and answered as it happens, with your own speech engines: replies come sooner and the caller can interrupt. Works with Twilio, Telnyx and Plivo, and needs the public address above. Off: caller and assistant take turns."
        checked={settingValue(settings, 'voice.streaming') === true}
        saver={saver}
      />

      <div className="space-y-1.5" data-testid="call-assistant">
        <TextSetting
          settingKey="voice.callAssistant"
          label="Your full assistant on the phone"
          hint={
            <>
              Callers normally talk to a phone assistant that has no tools, because anyone can call. A number listed here, with the user it
              belongs to, reaches that user&apos;s full assistant instead: tools, files, mail, on a new chat of theirs. Write it as
              number: username, separated by commas. Questions the assistant would ask on screen (may I use this tool?) are asked
              aloud: a plain yes allows, anything else refuses. Calls placed by the assistant never get it.
            </>
          }
          value={assistantText(settingValue(settings, 'voice.callAssistant'))}
          placeholder="+14155551234: alice"
          saver={saver}
          toValue={assistantEntries}
        />
        <p className="text-xs text-on-surface-variant" data-testid="call-assistant-caveat">
          A caller ID can be faked, so the number alone is not enough: the provider must also report it as verified with full STIR/SHAKEN
          attestation (A). Twilio, Telnyx and Plivo all report it, but only for calls on US and Canadian networks; from anywhere else, and
          whenever the check is weaker or missing, the caller gets the phone assistant without tools. It also needs live audio (above)
          and incoming calls that let the number in.
        </p>
      </div>

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
