'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Loader2,
  Plus,
  Star,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';

interface OAuthStatus {
  connected: boolean;
  provider: string;
  email?: string;
  scopes?: string[];
  expiresAt?: string;
  accounts?: number;
}

/** One connected account of a provider; the default one comes first. */
interface OAuthAccount {
  account?: string;
  isDefault: boolean;
}

export function OAuthIntegrationsSection() {
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
      <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-1">OAuth Integrations</h3>
      <p className="text-xs text-on-surface-variant mb-3">
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

  // Every connected account, the default first. Agents, the heartbeat and the pages use the default unless told otherwise.
  const { data: accountList } = useQuery({
    queryKey: ['oauth-accounts', provider.id],
    enabled: !!status?.connected,
    queryFn: async () => (await api.get<{ accounts: OAuthAccount[] }>(`/auth/oauth/${provider.id}/accounts`)).accounts,
  });
  const accounts = accountList ?? [];
  const [busy, setBusy] = useState('');

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['oauth-status', provider.id] });
    queryClient.invalidateQueries({ queryKey: ['oauth-accounts', provider.id] });
    // The Email and Calendar pages list the accounts too.
    queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
    queryClient.invalidateQueries({ queryKey: ['calendar-list'] });
  };

  /** Connect (or, with `addAccount`, connect a further account next to the ones there are). */
  const handleConnect = async (addAccount = false) => {
    setConnecting(true);
    setError('');
    try {
      const { url } = await api.get<{ url: string }>(`/auth/oauth/${provider.id}/authorize${addAccount ? '?addAccount=true' : ''}`);
      const popup = window.open(url, 'oauth', 'width=600,height=700,left=200,top=100');

      // Only the callback page in the popup we opened may report back: it
      // posts with its own origin as the target, which is this app's.
      const handler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.source !== popup) return;
        if (event.data?.type === 'oauth_callback') {
          window.removeEventListener('message', handler);
          if (event.data.success === false && typeof event.data.error === 'string') setError(event.data.error);
          refresh();
          setConnecting(false);
        }
      };
      window.addEventListener('message', handler);

      // Fallback: if popup is closed without postMessage
      const check = setInterval(() => {
        if (popup?.closed) {
          clearInterval(check);
          window.removeEventListener('message', handler);
          refresh();
          setConnecting(false);
        }
      }, 1000);
    } catch (err) {
      setError((err as Error).message);
      setConnecting(false);
    }
  };

  /** Without an account: the provider, every account of it. */
  const handleDisconnect = async (account?: string) => {
    setDisconnecting(true);
    setBusy(account ? `off:${account}` : 'off');
    setError('');
    try {
      await api.post(`/auth/oauth/${provider.id}/disconnect`, account ? { account } : undefined);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setDisconnecting(false);
    setBusy('');
  };

  const makeDefault = async (account: string) => {
    setBusy(`default:${account}`);
    setError('');
    try {
      await api.post(`/auth/oauth/${provider.id}/accounts/default`, { account });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy('');
  };

  return (
    <div className="p-4 bg-surface-container-low rounded-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h4 className="font-medium text-sm text-on-surface">{provider.name}</h4>
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-on-surface-variant" />
          ) : (
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                status?.connected
                  ? 'bg-tertiary-container/60 text-tertiary'
                  : 'bg-surface-container-high text-on-surface-variant'
              }`}
            >
              {status?.connected ? 'Connected' : 'Not connected'}
            </span>
          )}
        </div>
        {status?.connected ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleConnect(true)}
              disabled={connecting}
              className="px-3 py-1.5 text-xs border border-outline-variant/60 text-on-surface rounded-lg hover:bg-surface-container-high disabled:opacity-50 flex items-center gap-1"
            >
              {connecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Add another account
            </button>
            {accounts.length <= 1 && (
              <button
                onClick={() => handleDisconnect()}
                disabled={disconnecting}
                className="px-3 py-1.5 text-xs border border-error-dim/30 text-error rounded-lg hover:bg-error-dim/10 disabled:opacity-50"
              >
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={() => handleConnect()}
            disabled={connecting}
            className="px-3 py-1.5 text-xs bg-primary text-on-primary cursor-pointer rounded-lg hover:bg-primary-dim disabled:opacity-50 flex items-center gap-1"
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
      <p className="text-xs text-on-surface-variant">{provider.description}</p>
      {status?.connected && accounts.length <= 1 && (status.email || accounts[0]?.account) && (
        <p className="text-xs text-on-surface-variant mt-1">
          Connected as: <span className="text-on-surface">{status.email || accounts[0]?.account}</span>
        </p>
      )}
      {status?.connected && accounts.length > 1 && (
        <ul aria-label={`${provider.name} accounts`} className="mt-2 divide-y divide-outline-variant/20 rounded-md border border-outline-variant/30">
          {accounts.map((a, i) => (
            <li key={a.account ?? `account-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-on-surface">{a.account ?? 'Address not known yet'}</span>
              {a.isDefault ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2 py-0.5 text-on-primary-container" title="Agents, the heartbeat and the pages use this account unless one is chosen">
                  <Star className="w-3 h-3" /> Default
                </span>
              ) : a.account ? (
                <button onClick={() => makeDefault(a.account!)} disabled={!!busy} className="px-2 py-1 rounded-md border border-outline-variant/60 text-on-surface hover:bg-surface-container-high disabled:opacity-50">
                  {busy === `default:${a.account}` ? 'Saving…' : 'Make default'}
                </button>
              ) : null}
              {a.account && (
                <button onClick={() => handleDisconnect(a.account)} disabled={!!busy} aria-label={`Disconnect ${a.account}`} className="px-2 py-1 rounded-md border border-error-dim/30 text-error hover:bg-error-dim/10 disabled:opacity-50">
                  {busy === `off:${a.account}` ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {status?.connected && accounts.length > 1 && (
        <p className="text-xs text-on-surface-variant mt-2">The agent&apos;s tools and the heartbeat use the default account. The Email and Calendar pages show every account.</p>
      )}
      {error && (
        <div className="mt-2 p-2.5 bg-amber-900/20 border border-amber-800/30 rounded-lg">
          <p className="text-xs text-amber-200">
            {error.includes('not configured') ? (
              <>Add your Client ID and Client Secret on the <Link href="/secrets" className="font-semibold underline hover:text-amber-100">Secrets page</Link>, then try connecting again.</>
            ) : error}
          </p>
        </div>
      )}
    </div>
  );
}
