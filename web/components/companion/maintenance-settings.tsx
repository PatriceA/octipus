'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CompanionMaintenance } from '../../../src/shared/companion-maintenance';

export function MaintenanceSettings() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['companion-maintenance'], queryFn: () => api.get<{ runtime: CompanionMaintenance; userId: string }>('/settings/companion-maintenance') });
  const [edited,setDraft]=useState<CompanionMaintenance|null>(null), [editedRoots,setRoots]=useState<string|null>(null), [busy,setBusy]=useState(false), [message,setMessage]=useState('');
  const draft=edited ?? query.data?.runtime;
  const roots=editedRoots ?? draft?.roots.join('\n') ?? '';
  if(!draft) return <p>{query.error?.message ?? 'Loading maintenance runtime…'}</p>;
  const field='rounded-md border border-outline-variant bg-surface-container p-2 text-sm';
  return <section className="space-y-3 rounded-md border border-outline-variant p-4">
    <h3 className="font-medium">Companion maintenance runtime</h3>
    <p className="text-sm text-on-surface-variant">Opt in to repairs of this Octipus installation and its host prerequisites. This runtime has its own writable directories and works independently of project sandbox mounts. Shell policy denials still apply. No command lists or private-key copies are needed.</p>
    {(message||query.error)&&<p role="status">{message||query.error?.message}</p>}
    <form className="space-y-3" onSubmit={event=>{event.preventDefault();setBusy(true);setMessage('');void api.put('/settings/companion-maintenance',{...draft,roots:roots.split('\n').map(v=>v.trim()).filter(Boolean)})
      .then(async()=>{setMessage('Maintenance scope saved. Changed bindings revoke previous maintenance sessions.');await cache.invalidateQueries({queryKey:['companion-maintenance']});setDraft(null);setRoots(null);}).catch(error=>setMessage(error.message)).finally(()=>setBusy(false));}}>
      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event=>setDraft({...draft,enabled:event.target.checked})}/>Enable maintenance for my account</label>
      <label className="block">Writable directories, one per line<textarea className={`${field} block w-full`} rows={3} value={roots} disabled={busy} onChange={event=>setRoots(event.target.value)} placeholder="Installation, configuration, SDK and cache directories"/></label>
      {(['hostServices','sshAgent','allowActivation'] as const).map((name,index)=><label key={name} className="flex items-center gap-2"><input type="checkbox" checked={draft[name]} disabled={busy} onChange={event=>setDraft({...draft,[name]:event.target.checked})}/>{['Host network, Docker socket and USB devices','Existing host SSH-agent socket','Managed build activation and restart handoff'][index]}</label>)}
      <p className="text-xs text-on-surface-variant">Approved directories and their contents are readable and writable by maintenance commands. Host services and an SSH agent expose the selected host capabilities. Credential use remains within your authorized work; do not add private keys to chat or repositories.</p>
      <label className="block">Activation while work is active <select className={field} value={draft.interruptionPolicy} disabled={busy} onChange={event=>setDraft({...draft,interruptionPolicy:event.target.value as 'wait'|'interrupt'})}><option value="wait">Wait until active work finishes</option><option value="interrupt">Allow interruption; resume captured supervised pipelines</option></select></label>
      <p className="text-xs text-on-surface-variant">The handoff waits or interrupts according to this policy. Maintenance shell commands run as the server account and can themselves affect services; this setting controls the managed handoff, not an OS privilege boundary. Interruption affects this installation. Only captured supervised pipelines are eligible for automatic continuation. Runtime verification is still required after restart.</p>
      <button className={field} disabled={busy}>Save maintenance runtime</button>
    </form>
    <button className={field} disabled={busy||!draft.enabled} onClick={()=>{setBusy(true);setMessage('');void api.post<{passed:boolean;summary:string}>('/settings/companion-maintenance/test',{}).then(result=>setMessage(`${result.passed?'Passed':'Failed'}: ${result.summary}`)).catch(error=>setMessage(error.message)).finally(()=>setBusy(false));}}>Test saved runtime</button>
  </section>;
}
