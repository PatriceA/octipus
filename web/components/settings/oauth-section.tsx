'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Loader2,
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
    <div className="p-4 bg-surface-container-low rounded-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h4 className="font-medium text-sm text-white">{provider.name}</h4>
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-on-surface-variant" />
          ) : (
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                status?.connected
                  ? 'bg-green-900/30 text-green-300'
                  : 'bg-[#262626] text-on-surface-variant'
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
            className="px-3 py-1.5 text-xs border border-error-dim/30 text-error rounded-lg hover:bg-error-dim/10 disabled:opacity-50"
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-3 py-1.5 text-xs bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container disabled:opacity-50 flex items-center gap-1"
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
      {status?.connected && status.email && (
        <p className="text-xs text-on-surface-variant mt-1">
          Connected as: <span className="text-white">{status.email}</span>
        </p>
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
