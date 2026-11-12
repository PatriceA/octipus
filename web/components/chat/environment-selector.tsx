'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

type Selection = { selectedEnvironmentId?: string | null; projectPath?: string | null; defaultEnvironmentId?: string | null;
  environment: { id?: string; name?: string; backend: string; machine?: string; account?: string; note?: string };
  available: Array<{ id: string; name: string; backend: string; authority?: string; roots: string[] }>; error?: string };
const contains = (root: string, path: string) => { const base = root.replace(/[\\/]+$/, ''); return path === base || path.startsWith(base + '/') || path.startsWith(base + '\\'); };

export function EnvironmentSelector({ sessionId, running }: { sessionId: string | null; running: boolean }) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ id: string; path: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const { data, error: loadError } = useQuery({ queryKey: ['session-environment', sessionId], queryFn: () => api.get<Selection>(`/sessions/${sessionId}/execution-environment`), enabled: !!sessionId, staleTime: 10000 });
  if (loadError) return <div role="alert" className="px-4 py-2 text-xs">Could not load execution environment: {loadError.message}</div>;
  if (!sessionId || !data || (!data.available.length && data.environment.backend === 'legacy')) return null;
  async function apply(id: string, projectPath?: string) {
    setSaving(true); setError('');
    try { await api.put(`/sessions/${sessionId}/execution-environment`, { environmentId: id || null, projectPath, expectedEnvironmentId: data?.selectedEnvironmentId ?? null }); await client.invalidateQueries({ queryKey: ['session-environment', sessionId] }); setPending(null); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }
  function select(id: string) {
    setError('');
    const target = data?.available.find(entry => entry.id === (id || data.defaultEnvironmentId));
    const previous = data?.projectPath;
    if (target && (!previous || !(target.authority === 'account' && target.backend === data?.environment.backend) && !target.roots.some(root => contains(root, previous)))) { setPending({ id, path: target.roots[0] }); return; }
    setPending(null); void apply(id, target && previous ? previous : undefined);
  }
  return <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/40 px-4 py-2 text-xs" aria-label="Execution environment">
    <label>Runs on <select aria-label="Project execution environment" disabled={running || saving} value={pending?.id ?? data.selectedEnvironmentId ?? ''} onChange={event => select(event.target.value)} className="ml-1 max-w-52 rounded border border-outline-variant bg-surface-container px-2 py-1"><option value="">Use workspace default</option>{data.selectedEnvironmentId && !data.available.some(entry => entry.id === data.selectedEnvironmentId) && <option value={data.selectedEnvironmentId}>Unavailable environment</option>}{data.available.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.backend}</option>)}</select></label>
    {data.environment.account && <span>{data.environment.name}: {data.environment.account}@{data.environment.machine}</span>}
    {data.projectPath && <span className="max-w-72 truncate" title={data.projectPath}>{data.projectPath}</span>}
    {pending && <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void apply(pending.id, pending.path); }}><label>Project folder on the selected machine <input required aria-label="Environment project folder" className="rounded border bg-surface-container px-2 py-1" value={pending.path} onChange={event => setPending({ ...pending, path: event.target.value })} /></label><button disabled={running || saving} type="submit">Use this folder</button><button type="button" onClick={() => setPending(null)}>Cancel</button></form>}
    {running && <span>Change after the current work stops.</span>}
    <a href="/settings?tab=environments" className="text-primary underline">Environment access</a>
    {(error || data.error) && <span role="alert">{error || data.error}</span>}
  </div>;
}
