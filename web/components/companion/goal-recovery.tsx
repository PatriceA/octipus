'use client';
import Link from 'next/link';
import { VerificationEvidence } from '@/components/verification-evidence';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CompanionGoalView } from '../../../src/shared/companion-supervision';

type Incident={id:string;revision:number;sessionId:string;category:string;state:string;summary:string;strategies:string[];evidenceId:string|null;updatedAt:string};
export function GoalRecovery({goal,workspaceId}:{goal:CompanionGoalView;workspaceId:string}) {
  const cache=useQueryClient();const [dependencies,setDependencies]=useState((goal.dependencies??[]).join('\n')),[budget,setBudget]=useState(goal.tokenBudget?.toString()??''),[root,setRoot]=useState(''),[host,setHost]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const incidents=useQuery({queryKey:['companion',workspaceId,goal.id,'incidents'],queryFn:()=>api.get<{incidents:Incident[]}>(`/companion/goals/${goal.id}/incidents`),refetchInterval:5000});
  const authorized=!!goal.executionPolicy;
  const save=async(revoke:boolean)=>{setBusy(true);setError('');try {await api.put(`/companion/goals/${goal.id}/authorization`,{expectedRevision:goal.revision,profile:revoke?null:{executionScope:'run',repoPath:root,hostServices:host,overnight:true,autoApproveGates:true}});await cache.invalidateQueries({queryKey:['companion',workspaceId]});}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const field='rounded-xs border border-outline-variant bg-surface-container px-3 py-2 text-sm';
  return <div className="space-y-4">
    <section className="space-y-2" aria-label="Goal execution scope"><h3>Execution scope</h3>
      <p className="text-sm text-on-surface-variant">Approve work for this goal across the selected repository and its subdirectories, including new commands, scripts, remote deployment, cleanup and network use of credentials and private data. Child pipelines inherit this scope. Existing policy denials and filesystem boundaries still apply. No command list is required.</p>
      {error&&<p role="alert">{error}</p>}
      {authorized?<><p className="text-sm">Approved: {goal.executionPolicy?.approvedAt ? new Date(goal.executionPolicy.approvedAt).toLocaleString():'current goal scope'} · {String((goal.executionPolicy?.profile as {repoPath?:string})?.repoPath??'')}</p><button className={field} disabled={busy} onClick={()=>void save(true)}>Revoke execution scope</button></>:<form className="space-y-2" onSubmit={event=>{event.preventDefault();void save(false);}}><label className="block">Repository directory<input className={`${field} block w-full`} value={root} onChange={event=>setRoot(event.target.value)} required placeholder="/home/you/projects/project"/></label><label className="flex gap-2"><input type="checkbox" checked={host} onChange={event=>setHost(event.target.checked)}/>Include host network services, Docker and USB devices</label><button className={field} disabled={busy||!root||['completed','cancelled'].includes(goal.state)}>Approve execution for this goal</button></form>}
    </section>
    <form className="space-y-2" aria-label="Goal scheduling" onSubmit={event=>{event.preventDefault();setBusy(true);setError('');void api.patch(`/companion/goals/${goal.id}`,{expectedRevision:goal.revision,dependencies:dependencies.split('\n').map(v=>v.trim()).filter(Boolean),tokenBudget:budget?Number(budget):null}).then(()=>cache.invalidateQueries({queryKey:['companion',workspaceId]})).catch(error=>setError(error.message)).finally(()=>setBusy(false));}}>
      <h3>Scheduling</h3><label className="block">Prerequisite goal IDs, one per line<textarea className={`${field} block w-full`} value={dependencies} onChange={event=>setDependencies(event.target.value)} placeholder="Leave empty for independent work"/></label>
      <label className="block">Goal token budget (optional)<input type="number" min={1000} max={1000000000} className={`${field} block w-full`} value={budget} onChange={event=>setBudget(event.target.value)}/></label>
      <p className="text-xs text-on-surface-variant">Dependent work starts after its prerequisites are verified complete. Supervised dispatches share checkout and maintenance-runtime claims. Existing direct work is not automatically enrolled.</p><button className={field} disabled={busy||['completed','cancelled'].includes(goal.state)}>Save goal scheduling</button>
    </form>
    <section className="space-y-2" aria-label="Recovery incidents"><h3>Recovery</h3>{incidents.error&&<p role="alert">{incidents.error.message}</p>}
      {incidents.data?.incidents.length===0&&<p className="text-sm text-on-surface-variant">No recorded incidents.</p>}
      {incidents.data?.incidents.map(incident=><article key={incident.id} className="space-y-1 border-l-2 border-outline-variant pl-3 text-sm"><p>{incident.category.replaceAll('_',' ')} · {incident.state} · {incident.strategies.length} strategies</p><p className="whitespace-pre-wrap">{incident.summary}</p><p className="text-xs text-on-surface-variant">Classification suggests what to inspect; it does not establish the underlying cause.</p><Link className="underline" href={`/chat?session=${incident.sessionId}`}>Affected session and evidence</Link>{incident.evidenceId&&<details><summary className="cursor-pointer underline">Inspect verification</summary><VerificationEvidence sessionId={incident.sessionId} workspaceId={workspaceId} evidenceId={incident.evidenceId}/></details>}{incident.state==='escalated'&&<div><p>Repair limit reached. Automatic retries have stopped.</p><button className={field} disabled={busy} onClick={()=>{setBusy(true);setError('');void api.post(`/companion/goals/${goal.id}/incident-decision`,{incidentId:incident.id,expectedRevision:incident.revision}).then(()=>cache.invalidateQueries({queryKey:['companion',workspaceId]})).catch(error=>setError(error.message)).finally(()=>setBusy(false));}}>Allow one additional repair strategy</button></div>}</article>)}
    </section>
    {!!goal.completionEvidence?.length&&<section className="space-y-2"><h3>Verified acceptance</h3>{goal.completionEvidence.map(evidence=><p key={evidence.evidenceId} className="text-sm">{goal.acceptanceCriteria[evidence.criterionIndex]}: {evidence.summary} <span className="text-xs break-all">({evidence.evidenceId})</span></p>)}</section>}
  </div>;
}
