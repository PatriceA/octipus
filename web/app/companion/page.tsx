'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { GoalRecovery } from '@/components/companion/goal-recovery';
import { CompanionChatEntry } from '@/components/companion/chat-entry';
import { useCompanionChat } from '@/hooks/useCompanionChat';
import { SupervisionSettings } from '@/components/companion/supervision-settings';
import type { CompanionGoalView as CompanionGoal, CompanionLinkView as CompanionSessionLink, CompanionActionView as CompanionAction } from '../../../src/shared/companion-supervision';

type ModelChoice = { name: string; modelId: string; isEnabled: boolean; supportsTools: boolean; provider: string };
const field = 'w-full rounded-xs border border-outline-variant bg-surface-container px-3 py-2 text-sm';
const button = 'rounded-xs border border-outline-variant px-3 py-2 text-sm hover:bg-surface-container-high disabled:opacity-50';

function CompanionWorkspacePage() {
  const { activeWorkspace } = useWorkspace();
  const companionChat = useCompanionChat();
  const cache = useQueryClient();
  const [request, setRequest] = useState('');
  const [outcome, setOutcome] = useState('');
  const [criteria, setCriteria] = useState('');
  const [selected, setSelected] = useState<string | null>(() => { const id = new URLSearchParams(window.location.search).get('goal'); return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null; });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelName, setModelName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [message, setMessage] = useState('');
  const keys = useRef(new Map<string, string>());
  const key = (intent: unknown) => { const text = JSON.stringify([activeWorkspace?.id, intent]); if (!keys.current.has(text)) keys.current.set(text, crypto.randomUUID()); return keys.current.get(text)!; };
  async function postIntent<T>(path: string, body: Record<string, unknown>, intent: unknown): Promise<T> {
    const text = JSON.stringify([activeWorkspace?.id, intent]);
    const result = await api.post<T>(path, { ...body, requestKey: key(intent) });
    keys.current.delete(text);
    return result;
  }
  const personal = activeWorkspace?.kind === 'personal';
  const goals = useQuery({ queryKey: ['companion', activeWorkspace?.id], queryFn: () => api.get<{ goals: CompanionGoal[] }>('/companion/goals'), enabled: personal, refetchInterval: 5000 });
  const detail = useQuery({ queryKey: ['companion', activeWorkspace?.id, selected], queryFn: () => api.get<{ goal: CompanionGoal; links: CompanionSessionLink[] }>(`/companion/goals/${selected}`), enabled: personal && !!selected, refetchInterval: 5000 });
  const actions = useQuery({ queryKey: ['companion', activeWorkspace?.id, selected, 'actions'], queryFn: () => api.get<{ actions: CompanionAction[] }>(`/companion/goals/${selected}/actions`), enabled: personal && !!selected, refetchInterval: 5000 });
  const models = useQuery({ queryKey: ['models', activeWorkspace?.id], queryFn: () => api.get<{ models: ModelChoice[] }>('/models'), enabled: personal });
  const sessions = useQuery({ queryKey: ['companion-sessions', activeWorkspace?.id], queryFn: () => api.get<{ sessions: { id: string; title: string | null }[] }>('/sessions?limit=100'), enabled: personal });
  const goal = detail.data?.goal;
  const editable = goal && !['completed', 'cancelled'].includes(goal.state);
  async function change(run: () => Promise<unknown>) {
    setError(''); setBusy(true);
    try { await run(); await cache.invalidateQueries({ queryKey: ['companion', activeWorkspace?.id] }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="max-w-6xl space-y-6">
    <PageHeader title="Companion" description="Give your companion an outcome and follow its work across project sessions." />
    {!personal ? <p>Choose a personal workspace to supervise your projects.</p> : <>
      {companionChat.data?.supervisorSessionId && <CompanionChatEntry sessionId={companionChat.data.supervisorSessionId} />}
      {activeWorkspace && <SupervisionSettings key={activeWorkspace.id} workspaceId={activeWorkspace.id} models={models.data?.models ?? []} />}
      {(error || goals.error || detail.error || actions.error) && <p role="alert" className="text-error">{error || (goals.error || detail.error || actions.error)?.message}</p>}
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); void change(async () => {
        const created = await postIntent<CompanionGoal>('/companion/goals', { title: request.trim().slice(0, 100), request,
          outcome, acceptanceCriteria: criteria.split('\n').map(value => value.trim()).filter(Boolean) }, ['goal', request, outcome, criteria]);
        setSelected(created.id); setRequest(''); setOutcome(''); setCriteria('');
      }); }}>
        <label className="block space-y-2">What would you like done?<textarea className={field} value={request} onChange={event => setRequest(event.target.value)} required maxLength={20_000} rows={3} /></label>
        <label className="block">Desired outcome<input className={field} value={outcome} onChange={event => setOutcome(event.target.value)} required maxLength={4000} /></label>
        <label className="block">Acceptance criteria, one per line<textarea className={field} value={criteria} onChange={event => setCriteria(event.target.value)} required maxLength={10_000} rows={2} /></label>
        <button className={button} disabled={busy || !request.trim()}>Create goal</button>
      </form>
      <div className="grid gap-6 md:grid-cols-[240px_1fr]">
        <div className="space-y-2" aria-label="Goals">
          {goals.isLoading && <p>Loading goals…</p>}
          {goals.data?.goals.length === 0 && <p>No goals yet.</p>}
          {goals.data?.goals.map(item => <button key={item.id} className={`${button} block w-full text-left ${item.id === selected ? 'bg-surface-container-high' : ''}`} onClick={() => { setSelected(item.id); setError(''); }}>
            <span className="block">{item.title}</span><span className="text-xs text-on-surface-variant">{item.state.replaceAll('_', ' ')}</span>
          </button>)}
        </div>
        {goal && <section className="space-y-5" aria-label="Goal details">
          <div><h2 className="text-lg">{goal.title}</h2><p className="whitespace-pre-wrap text-sm">{goal.outcome}</p></div>
          <ul className="list-disc pl-5 text-sm">{goal.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul>
          <p className="text-xs text-on-surface-variant">Protection level {goal.protectionLevel} · Revision {goal.revision}</p>
          {editable && <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy} onClick={() => void change(() => api.patch(`/companion/goals/${goal.id}`, { expectedRevision: goal.revision, state: goal.state === 'paused' ? 'active' : 'paused' }))}>{goal.state === 'paused' ? 'Resume supervision' : 'Pause supervision'}</button>
            <button className={button} disabled={busy} onClick={() => void change(() => api.patch(`/companion/goals/${goal.id}`, { expectedRevision: goal.revision, state: 'cancelled' }))}>Stop supervision</button>
            <label>Priority <select className={button} value={goal.priority} disabled={busy} onChange={event => void change(() => api.patch(`/companion/goals/${goal.id}`, { expectedRevision: goal.revision, priority: Number(event.target.value) }))}>{['Normal', 'Low', 'Medium', 'High'].map((text, index) => <option key={text} value={index}>{text}</option>)}</select></label>
          </div>}
          <div className="space-y-2"><h3>Project sessions</h3>{detail.data?.links.map(link => <div key={link.id} className="space-x-2 text-sm"><Link className="underline" href={`/chat?session=${link.sessionId}`}>Open session</Link> · {link.purpose} · {link.active ? link.ownership : 'released'}{link.pipelineId && <Link className="ml-2 underline" href={`/pipelines?pipeline=${link.pipelineId}`}>Pipeline</Link>}
            {link.active && link.ownership === 'owner' && !link.pipelineId && editable && <>
              <button className={button} disabled={busy} onClick={() => void change(() => api.post(`/companion/goals/${goal.id}/control`, { sessionId: link.sessionId, state: 'paused' }))}>Pause session work</button>
              <button className={button} disabled={busy || goal.state === 'paused'} onClick={() => void change(async () => {
                await api.post(`/companion/goals/${goal.id}/control`, { sessionId: link.sessionId, state: 'active' });
                await postIntent(`/companion/goals/${goal.id}/messages`, { sessionId: link.sessionId, message: 'Continue the original authorized work from saved progress. Inspect current effects and checkpoint before retrying. Preserve completed work.' }, ['continue', goal.id, link.sessionId]);
              })}>Continue session work</button>
            </>}
          </div>)}</div>
          {editable && goal.state !== 'paused' && <>
            <form className="space-y-2" onSubmit={event => { event.preventDefault(); void change(() => postIntent(`/companion/goals/${goal.id}/sessions`, {
              expectedRevision: goal.revision, modelName, ...(projectPath ? { projectPath } : {}),
            }, ['start', goal.id, modelName, projectPath])); }}>
              <h3>Start a project session</h3>
              <label className="block">Model<select className={field} value={modelName} onChange={event => setModelName(event.target.value)} required><option value="">Choose a model</option>{models.data?.models.filter(model => model.isEnabled && (model.supportsTools || model.provider === 'cli') && !/ocr|embed|reasoner|thinking/i.test(model.modelId)).map(model => <option key={model.name} value={model.name}>{model.name}</option>)}</select></label>
              <label className="block">Project directory (optional)<input className={field} value={projectPath} onChange={event => setProjectPath(event.target.value)} /></label>
              <button className={button} disabled={busy || !modelName}>Start session</button>
            </form>
            <form className="space-y-2" onSubmit={event => { event.preventDefault(); void change(() => api.post(`/companion/goals/${goal.id}/adopt`, { expectedRevision: goal.revision, sessionId, purpose: goal.outcome })); }}>
              <label className="block">Adopt an existing session<select className={field} value={sessionId} onChange={event => setSessionId(event.target.value)} required><option value="">Choose a session</option>{sessions.data?.sessions.map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}</select></label>
              <button className={button} disabled={busy || !sessionId}>Adopt session</button>
            </form>
            <form className="space-y-2" onSubmit={event => { event.preventDefault(); void change(async () => { await postIntent(`/companion/goals/${goal.id}/messages`, { sessionId, message }, ['message', goal.id, sessionId, message]); setMessage(''); }); }}>
              <label className="block">Send instructions to the selected session<textarea className={field} value={message} onChange={event => setMessage(event.target.value)} maxLength={20_000} required /></label>
              <button className={button} disabled={busy || !sessionId || !message.trim()}>Send instructions</button>
            </form>
          </>}
          {activeWorkspace && <GoalRecovery key={`${activeWorkspace.id}:${goal.id}`} goal={goal} workspaceId={activeWorkspace.id} />}
          <div className="space-y-2"><h3>Activity</h3>{actions.data?.actions.map(action => <div className="border-l-2 border-outline-variant pl-3 text-sm" key={action.id}><p>{action.kind.replaceAll('_', ' ')} · {action.status}</p>{action.result && <p className="whitespace-pre-wrap text-on-surface-variant">{action.result}</p>}</div>)}</div>
        </section>}
      </div>
    </>}
  </div>;
}

export default function CompanionPage() {
  const { activeWorkspace } = useWorkspace();
  return <CompanionWorkspacePage key={activeWorkspace?.id ?? 'none'} />;
}
