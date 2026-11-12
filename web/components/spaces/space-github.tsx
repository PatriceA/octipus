'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Unplug } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface SpaceGithub {
  connected: boolean;
  connectedBy: string | null;
  connectedAt: string | null;
}

const buttonClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer';

/**
 * Space settings → GitHub (coworking §9.5): the space's own GitHub token,
 * used by the space's agent for every member who may run it. Every member
 * sees whether there is one; owners paste and remove it. The value never
 * reaches the browser.
 */
export function SpaceGithubToken({ spaceId, canManage }: { spaceId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const key = ['space', spaceId, 'github'];

  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<SpaceGithub>(`/spaces/${spaceId}/github`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: (value: string) => api.put<{ connected: true }>(`/spaces/${spaceId}/github`, { token: value }),
    onSuccess: () => { setError(null); setEditing(false); setToken(''); void refresh(); },
    onError: (err: Error) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/spaces/${spaceId}/github`),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (err: Error) => setError(err.message),
  });

  const github = q.data;
  return (
    <section aria-label="GitHub" className="space-y-2">
      <h2 className="section-label">github</h2>
      <p className="text-[12px] text-on-surface-variant">
        The space&apos;s GitHub token (fine-grained, limited to the team&apos;s repositories): its agent uses it for every member
        who may run it, and never the host&apos;s GitHub login.
      </p>
      {error && <p className="text-[12px] text-error">! {error}</p>}
      {q.isLoading ? <p className="text-[12px]">Loading…</p> : (
        <div className="term-frame rounded-xs px-3 py-2 text-[13px] space-y-1" data-testid="space-github">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-on-surface flex-1 min-w-0">
              GitHub
              <span className="text-on-surface-variant text-[12px]">
                {' · '}{github?.connected ? `connected${github.connectedBy ? ` by ${github.connectedBy}` : ''}` : 'not connected'}
              </span>
            </span>
            {canManage && (github?.connected ? (
              <button type="button" className={buttonClass} onClick={() => remove.mutate()} disabled={remove.isPending}>
                <Unplug className="w-3.5 h-3.5" aria-hidden /> Remove
              </button>
            ) : (
              <button type="button" className={buttonClass} disabled={save.isPending} onClick={() => setEditing(true)}>
                <Plug className="w-3.5 h-3.5" aria-hidden /> Add token
              </button>
            ))}
          </div>
          {editing && (
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(token); }}>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="GitHub token"
                aria-label="GitHub token"
                autoComplete="off"
                className="flex-1 min-w-0 px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px]"
              />
              <button type="submit" className={buttonClass} disabled={!token.trim() || save.isPending}>Save</button>
              <button type="button" className={buttonClass} onClick={() => { setEditing(false); setToken(''); }}>Cancel</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
