'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface SpaceConnector {
  id: string;
  name: string;
  description: string;
  kind: 'oauth' | 'token';
  connected: boolean;
  connectedBy: string | null;
  connectedAt: string | null;
}

const buttonClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer';

/**
 * Space settings → Connectors (coworking §9.5): the space's own connections,
 * used by the space's agent for every member who may run it. Every member
 * sees which are connected; owners connect (an OAuth popup, or a pasted
 * GitHub token) and disconnect. Values never reach the browser.
 */
export function SpaceConnectors({ spaceId, canManage }: { spaceId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const key = ['space', spaceId, 'connectors'];

  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ connectors: SpaceConnector[] }>(`/spaces/${spaceId}/connectors`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  // The OAuth popup reports back through the callback page's postMessage.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; error?: string } | null;
      if (data?.type === 'connector:connected') { setError(null); void refresh(); }
      if (data?.type === 'connector:error') setError(data.error ?? 'The connection failed');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  const connect = useMutation({
    mutationFn: (input: { id: string; token?: string }) =>
      api.post<{ connected?: true; url?: string }>(`/spaces/${spaceId}/connectors/${input.id}`, input.token ? { token: input.token } : {}),
    onSuccess: (res) => {
      setError(null);
      if (res.url) window.open(res.url, 'octipus-connector', 'width=600,height=720');
      setTokenFor(null);
      setToken('');
      void refresh();
    },
    onError: (err: Error) => setError(err.message),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.delete(`/spaces/${spaceId}/connectors/${id}`),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <section aria-label="Connectors" className="space-y-2">
      <h2 className="section-label">connectors</h2>
      <p className="text-[12px] text-on-surface-variant">
        Connections of the space: its agent uses them for every member who may run it, and never the host&apos;s GitHub login.
        Personal connectors stay personal.
      </p>
      {error && <p className="text-[12px] text-error">! {error}</p>}
      {q.isLoading ? <p className="text-[12px]">Loading…</p> : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {(q.data?.connectors ?? []).map((c) => (
            <li key={c.id} className="px-3 py-2 text-[13px] space-y-1" data-testid={`space-connector-${c.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-on-surface flex-1 min-w-0">
                  {c.name}
                  <span className="text-on-surface-variant text-[12px]">
                    {' · '}{c.connected ? `connected${c.connectedBy ? ` by ${c.connectedBy}` : ''}` : 'not connected'}
                  </span>
                </span>
                {canManage && (c.connected ? (
                  <button type="button" className={buttonClass} onClick={() => disconnect.mutate(c.id)} disabled={disconnect.isPending}>
                    <Unplug className="w-3.5 h-3.5" aria-hidden /> Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={connect.isPending}
                    onClick={() => (c.kind === 'token' ? setTokenFor(c.id) : connect.mutate({ id: c.id }))}
                  >
                    <Plug className="w-3.5 h-3.5" aria-hidden /> Connect
                  </button>
                ))}
              </div>
              <p className="text-[12px] text-on-surface-variant">{c.description}</p>
              {tokenFor === c.id && (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(e) => { e.preventDefault(); connect.mutate({ id: c.id, token }); }}
                >
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={`${c.name} token`}
                    aria-label={`${c.name} token`}
                    autoComplete="off"
                    className="flex-1 min-w-0 px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px]"
                  />
                  <button type="submit" className={buttonClass} disabled={!token.trim() || connect.isPending}>Save</button>
                  <button type="button" className={buttonClass} onClick={() => { setTokenFor(null); setToken(''); }}>Cancel</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
