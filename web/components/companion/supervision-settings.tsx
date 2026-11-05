'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CompanionSettingsInput } from '../../../../src/shared/companion-supervision';

type SettingsView = CompanionSettingsInput & { revision: number; supervisorSessionId: string | null };
export function SupervisionSettings({ workspaceId, models }: { workspaceId: string; models: Array<{ name: string; modelId: string; provider: string; supportsTools: boolean; isEnabled: boolean }> }) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['companion-settings', workspaceId], queryFn: () => api.get<SettingsView>('/companion/settings') });
  const [draft, setDraft] = useState<CompanionSettingsInput | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (query.data) { const { revision: _revision, supervisorSessionId: _session, ...options } = query.data; setDraft(options); } }, [query.data]);
  if (!draft) return <p>{query.error ? query.error.message : 'Loading supervision settings…'}</p>;
  const field = 'rounded-xs border border-outline-variant bg-surface-container px-3 py-2 text-sm';
  return <form className="space-y-3 rounded-xs border border-outline-variant p-4" aria-label="Supervision settings" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    void api.put<SettingsView>('/companion/settings', { expectedRevision: query.data?.revision ?? 0, settings: draft })
      .then(async () => { await cache.invalidateQueries({ queryKey: ['companion-settings', workspaceId] }); })
      .catch(error => setError((error as Error).message)).finally(() => setBusy(false));
  }}>
    <h2>Background supervision</h2>
    <p className="text-sm text-on-surface-variant">Companion checks committed changes while the browser is closed. Observation reports progress; coordination can start and steer sessions; repair uses your approved maintenance runtime.</p>
    {(error || query.error) && <p role="alert" className="text-error">{error || query.error?.message}</p>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />Enable background supervision</label>
    <label className="block">Supervisor model <select className={field} value={draft.modelName} required={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, modelName: event.target.value })}>
      <option value="">Choose an API or local model</option>{models.filter(model => model.isEnabled && model.supportsTools && model.provider !== 'cli' && !/ocr|embed|reasoner|thinking/i.test(model.modelId)).map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
    </select></label>
    <label className="block">Autonomy <select className={field} value={draft.autonomy} disabled={busy} onChange={event => setDraft({ ...draft, autonomy: event.target.value as CompanionSettingsInput['autonomy'] })}>
      <option value="observe">Observe and report</option><option value="coordinate">Coordinate sessions</option><option value="repair">Coordinate and repair</option>
    </select></label>
    <button className={field} disabled={busy}>Save supervision settings</button>
    {query.data?.supervisorSessionId && <Link className="ml-3 text-sm underline" href={`/chat?session=${query.data.supervisorSessionId}`}>Open Companion conversation</Link>}
  </form>;
}
