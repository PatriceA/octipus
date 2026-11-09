'use client';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, ClipboardList, Clock, Plus, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DESK_STATE_LABEL, workspaceDeskSchema, type DeskSession, type DeskState } from '../../../src/shared/workspace-desk';
import { useCompanionChat } from '@/hooks/useCompanionChat';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { useGateway, useGatewayStatus } from '@/lib/gateway-context';
import { PageHeader } from '@/components/ui/page-header';
import { OnboardingGuide } from '@/components/onboarding/onboarding-guide';

const chat = (id: string) => `/chat?session=${encodeURIComponent(id)}`;
function Badge({ state }: { state: DeskState }) { return <span className={`desk-state state-${state}`}><span aria-hidden />{DESK_STATE_LABEL[state]}</span>; }
function Inspector({ session }: { session: DeskSession }) {
  return <><header><span className="desk-label">Selected session</span><div className="flex items-center justify-between gap-3"><h2>{session.title}</h2><Badge state={session.state} /></div></header>
    <section><span className="desk-label">Current activity</span><h3>{session.activity}</h3>{session.next && <p>{session.next}</p>}{session.outcome && <p className="desk-recorded">{session.outcome}</p>}</section>
    <section><h3>Latest recorded changes</h3>{session.events.length ? <ol className="desk-timeline">{session.events.map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>{event.text}</span></li>)}</ol> : <p>No recent run history is available for this session.</p>}</section>
    {session.plan && <section className="desk-plan"><ClipboardList size={17} aria-hidden /><div><h3>Current plan · Revision {session.plan.revision}</h3><p>{session.plan.title}</p>{session.plan.changes.map(change => <p key={`${change.at}-${change.summary}`}><time dateTime={change.at}>{new Date(change.at).toLocaleDateString()}</time> · {change.summary}</p>)}<Link href={chat(session.id)}>View the current plan <ArrowRight size={13} aria-hidden /></Link></div></section>}
    <footer><Link className="desk-secondary" href={chat(session.id)}>Open session <ArrowRight size={15} aria-hidden /></Link></footer></>;
}
export function ProjectDesk() {
  const { activeWorkspace } = useWorkspace();
  return <Desk key={activeWorkspace?.id ?? 'resolving'} personal={activeWorkspace?.kind === 'personal'} workspaceName={activeWorkspace?.name ?? 'Workspace'} />;
}
function Desk({ personal, workspaceName }: { personal: boolean; workspaceName: string }) {
  const { activeWorkspace } = useWorkspace();
  const router = useRouter();
  const companion = useCompanionChat();
  const gateway = useGateway();
  const connected = useGatewayStatus() === 'connected';
  useEffect(() => { if (window.location.hash === '#budgets') router.replace('/settings?tab=usage'); }, [router]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<DeskState | 'all'>('all');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mobileDetails, setMobileDetails] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const snapshot = useQuery({ queryKey: ['workspace-desk', activeWorkspace?.id], queryFn: async () => workspaceDeskSchema.parse(await api.get('/sessions/desk')), enabled: personal, retry: false, refetchInterval: 30_000, staleTime: 15_000 });
  const companionId = companion.data?.supervisorSessionId;
  const stale = snapshot.isError || !!snapshot.data && Date.now() - Date.parse(snapshot.data.observedAt) > 90_000;
  const sessions = (snapshot.data?.sessions ?? []).filter(session => session.id !== companionId).map(session => stale ? { ...session, state: 'unknown' as const, activity: `Saved snapshot: ${session.activity}` } : session);
  const shown = sessions.filter(session => filter === 'all' || session.state === filter);
  const visible = shown.slice(0, 8);
  const selected = visible.find(session => session.id === selectedId) ?? visible[0];
  useEffect(() => { if (mobileDetails && selected && !dialog.current?.open) dialog.current?.showModal(); else if ((!mobileDetails || !selected) && dialog.current?.open) dialog.current.close(); }, [mobileDetails, selected]);
  const close = () => { setMobileDetails(false); opener.current?.focus(); };
  async function saveIdea() {
    if (!draft.trim()) return;
    setSaving(true); setError('');
    try { await api.post('/tasks', { title: draft.trim().slice(0, 500), notes: draft.trim().length > 500 ? draft.trim() : undefined, priority: 0, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); setDraft(''); router.push('/tasks'); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }
  function send() {
    setError('');
    if (!draft.trim() || !companionId) return;
    if (!gateway.send({ type: 'chat.send', sessionId: companionId, content: draft.trim(), workspaceId: activeWorkspace?.id, renders: ['inline_ui'] })) { setError('Not connected. Your message is still here.'); return; }
    setDraft(''); router.push(chat(companionId));
  }
  if (!personal) return <div className="project-desk"><PageHeader title={workspaceName} description="Your shared work stays in this workspace." /><section className="desk-context"><h2>Work together</h2><p>Open a shared room or review this workspace’s next steps.</p><div className="flex gap-3 mt-4"><Link className="desk-primary" href="/rooms">Open rooms <ArrowRight size={16} /></Link><Link className="desk-secondary" href="/tasks">Next steps</Link></div></section></div>;
  return <div className="project-desk">
    <PageHeader title="Workspace" badge={<span className="desk-workspace-name">{workspaceName}</span>} actions={<Link className="desk-primary" href="/chat?new=1"><Plus size={16} aria-hidden />New session</Link>} />
    <OnboardingGuide variant="home" />
    <section className="desk-companion-strip" aria-label="Companion"><img src="/companion-mark.svg" alt="" /><div><div className="flex items-center gap-3 flex-wrap"><strong>Companion</strong><span>{companion.isError ? 'Status unavailable' : companion.isPending ? 'Loading…' : companion.data?.enabled ? 'Supervision enabled' : 'Supervision disabled'}</span></div><p>{sessions.some(session => session.state === 'needs_you') ? `${sessions.filter(session => session.state === 'needs_you').length} session(s) need your answer.` : snapshot.isError ? 'Workspace status could not be refreshed.' : 'Follow your work or hand over the next step.'}</p></div><Link className="desk-companion-button" href={companionId ? chat(companionId) : '/companion'}>{companionId ? 'Open Companion' : 'Set up Companion'}<ArrowRight size={15} aria-hidden /></Link></section>
    {(snapshot.isError || !!snapshot.data?.warnings.length) && <div role="status" className="desk-warning"><strong>{snapshot.isError ? 'Workspace status is unavailable.' : 'Some status could not be confirmed.'}</strong>{snapshot.data && snapshot.isError && <p>Showing a saved snapshot from {new Date(snapshot.data.observedAt).toLocaleTimeString()}. It may be out of date.</p>}{snapshot.error && <p>{snapshot.error.message}</p>}{snapshot.data?.warnings.map(warning => <p key={warning}>{warning}</p>)}<button onClick={() => void snapshot.refetch()} className="desk-link">Retry <RefreshCw size={13} /></button></div>}
    <div className="desk-layout"><section aria-label="Sessions" className="desk-sessions"><header className="desk-section-heading"><h2>Sessions</h2><span>{snapshot.data ? `Snapshot ${new Date(snapshot.data.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : snapshot.isPending ? 'Loading…' : 'Unavailable'}</span></header>
      <div className="desk-filters" role="group" aria-label="Filter sessions">{(['all', 'working', 'needs_you', 'blocked', 'paused', 'updated', 'idle', 'unknown'] as const).map(state => { const count = state === 'all' ? sessions.length : sessions.filter(session => session.state === state).length; if (!count && state !== 'all' && filter !== state) return null; return <button key={state} type="button" aria-pressed={filter === state} onClick={() => setFilter(state)}>{state === 'all' ? 'All' : DESK_STATE_LABEL[state]}<span>{count}</span></button>; })}</div>
      {shown.length > 8 && <p className="text-xs text-on-surface-variant mb-3">Showing 8 of {shown.length} loaded sessions.</p>}
      {snapshot.isPending && <p className="desk-empty">Loading your sessions…</p>}
      {!snapshot.isPending && !snapshot.isError && shown.length === 0 && <div className="desk-empty"><p>{sessions.length ? 'No sessions match this filter.' : 'Start a session or bring your first idea to Companion.'}</p><Link href="/chat?new=1" className="desk-link">Start new work <Plus size={14} /></Link></div>}
      <div className="desk-session-list">{visible.map(session => <article key={session.id} className={`desk-session ${selected?.id === session.id ? 'selected' : ''}`}><button type="button" className="desk-session-select" aria-label={`Inspect ${session.title}`} aria-pressed={selected?.id === session.id} onClick={event => { setSelectedId(session.id); if (matchMedia('(max-width: 900px)').matches) { opener.current = event.currentTarget; setMobileDetails(true); } }}><span className="desk-session-mark">{session.title.slice(0, 2)}</span><span className="desk-session-name">{session.title}<small>Updated {new Date(session.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</small></span><Badge state={session.state} /></button><div className="desk-session-content"><h3>{session.activity}</h3>{session.outcome && <p>{session.outcome}</p>}{session.next && <div className="desk-next"><span>Next</span><p>{session.next}</p></div>}</div><footer><span>{session.state === 'working' ? <Activity size={13} /> : <Clock size={13} />} {session.state === 'needs_you' ? 'Waiting for your answer' : 'Recorded session state'}</span><Link href={chat(session.id)}>{session.state === 'needs_you' ? 'Review request' : 'Open session'}<ArrowRight size={13} /></Link></footer></article>)}</div><Link className="desk-all-sessions" href="/chat">View all sessions{snapshot.data && ` · ${snapshot.data.total}`}<ArrowRight size={14} /></Link>
    </section><aside className="desk-inspector" aria-label="Selected session">{selected ? <Inspector session={selected} /> : <div className="desk-empty">Select a session to see its current activity and plan changes.</div>}</aside></div>
    <form className="desk-composer" onSubmit={event => { event.preventDefault(); send(); }}><Sparkles size={20} className="desk-spark" aria-hidden /><label className="sr-only" htmlFor="desk-message">Message Companion</label><input id="desk-message" disabled={saving} value={draft} maxLength={2000} onChange={event => setDraft(event.target.value)} placeholder={companionId ? 'Ask Companion, start work, or save an idea…' : 'Save an idea for later, or set up Companion…'} /><button type="button" title="Save an idea as a to-do" aria-label="Save idea" disabled={!draft.trim() || saving} onClick={() => void saveIdea()}><ClipboardList size={16} /><span>Save idea</span></button><button className="desk-companion-button" aria-label="Send to Companion" disabled={!draft.trim() || !companionId || !connected || saving}><Send size={16} /></button></form>
    {error && <p role="alert" className="desk-warning">{error}</p>}
    <div className="desk-bottom"><span>{!connected ? 'Live updates disconnected' : 'Connected'} · snapshots refresh every 30 seconds</span><Link href="/tasks">To-dos for later</Link><Link href="/agents">Activity & system details</Link><Link href="/settings?tab=usage">Usage & budgets</Link></div>
    <dialog ref={dialog} className="desk-mobile-inspector" aria-label={selected ? `${selected.title} details` : 'Session details'} onCancel={close} onClose={close}><button type="button" className="desk-dialog-close" aria-label="Close session details" onClick={close}><X size={18} /></button>{selected && <Inspector session={selected} />}</dialog>
  </div>;
}
