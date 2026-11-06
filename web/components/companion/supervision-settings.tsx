'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CompanionSettingsInput } from '../../../src/shared/companion-supervision';

type SettingsView = CompanionSettingsInput & { settingsId?: string | null; revision: number; supervisorSessionId: string | null };
export function SupervisionSettings({ workspaceId, models, compact = false }: { compact?: boolean; workspaceId: string; models: Array<{ name: string; modelId: string; provider: string; supportsTools: boolean; isEnabled: boolean }> }) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['companion-settings', workspaceId], queryFn: () => api.get<SettingsView>('/companion/settings') });
  if (!query.data) return <p>{query.error ? query.error.message : 'Loading supervision settings…'}</p>;
  return <SupervisionSettingsForm key={query.data.revision} initial={query.data} models={models} compact={compact} refresh={async () => { await cache.invalidateQueries({ queryKey: ['companion-settings', workspaceId] }); }} />;
}

function SupervisionSettingsForm({ initial, models, compact, refresh }: {
  initial: SettingsView; models: Array<{ name: string; modelId: string; provider: string; supportsTools: boolean; isEnabled: boolean }>; compact: boolean; refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<CompanionSettingsInput>(() => {
    const { settingsId: _settingsId, revision: _revision, supervisorSessionId: _session, ...options } = initial;
    return options;
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const field = 'rounded-xs border border-outline-variant bg-surface-container px-3 py-2 text-sm';
  return <form className="space-y-3 rounded-xs border border-outline-variant p-4" aria-label={compact ? "Companion model assignment" : "Supervision settings"} onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    void api.put<SettingsView>('/companion/settings', { expectedRevision: initial.revision, settings: draft })
      .then(refresh)
      .catch(error => setError((error as Error).message)).finally(() => setBusy(false));
  }}>
    <h2>{compact ? "Companion model" : "Background supervision"}</h2>
    <p className="text-sm text-on-surface-variant">{compact ? "Companion uses the General role with this fixed model, independently of topic routing." : "Companion checks committed changes while the browser is closed. Observation reports progress; coordination can start and steer sessions; repair uses your approved maintenance runtime."}</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    {!compact && <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />Enable background supervision</label>}
    <label className="block">Supervisor model <select className={field} value={draft.modelName} required={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, modelName: event.target.value })}>
      <option value="">Choose an API or local model</option>{models.filter(model => model.isEnabled && model.supportsTools && model.provider !== 'cli' && !/ocr|embed|reasoner|thinking/i.test(model.modelId)).map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
    </select></label>
    {!compact && <><label className="block">Autonomy <select className={field} value={draft.autonomy} disabled={busy} onChange={event => setDraft({ ...draft, autonomy: event.target.value as CompanionSettingsInput['autonomy'] })}>
      <option value="observe">Observe and report</option><option value="coordinate">Coordinate sessions</option><option value="repair">Coordinate and repair</option>
    </select></label>
    <fieldset className="grid gap-2 sm:grid-cols-2"><legend>Resource limits</legend>
      {(['maxConcurrent','dailyTokenBudget','turnTokenBudget','maxRepairAttempts','quietHoursStart','quietHoursEnd'] as const).map((name,index)=><label key={name} className="block">{['Concurrent supervised sessions','Daily token budget (UTC day)','Tokens per turn','Repair strategies per incident','Quiet hours start (0–23)','Quiet hours end (0–23)'][index]}<input type="number" className={`${field} block w-full`} value={draft[name]} disabled={busy} min={name.startsWith('quiet')?0:name.includes('Budget')?1000:1} max={name==='maxConcurrent'?8:name==='maxRepairAttempts'?5:name.startsWith('quiet')?23:name==='turnTokenBudget'?100000:10000000} onChange={event=>setDraft({...draft,[name]:Number(event.target.value)})}/></label>)}
      <label className="block">Quiet-hours timezone<input className={`${field} block w-full`} value={draft.timezone} disabled={busy} onChange={event=>setDraft({...draft,timezone:event.target.value})}/></label>
    </fieldset>
    <p className="text-xs text-on-surface-variant">Limits reserve tokens before dispatch and pause pipelines at node boundaries. A model call already in progress may finish above its estimate. Quiet hours delay app notifications while authorized background work continues.</p></>}
    <button className={field} disabled={busy}>{compact ? "Save Companion model" : "Save supervision settings"}</button>
    {compact && <Link className="ml-3 text-sm underline" href="/companion">Supervision settings · {draft.enabled ? "Enabled" : "Disabled"}</Link>}
    {initial.supervisorSessionId && <Link className="ml-3 text-sm underline" href={`/chat?session=${initial.supervisorSessionId}`}>Open Companion conversation</Link>}
  </form>;
}
