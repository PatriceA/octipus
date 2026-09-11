import { useEffect, useState } from 'react';
import { ZodError } from 'zod';
import { Check, Circle, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { workPlanViewSchema, workPlanStateSchema, type WorkPlan, type WorkPlanState } from '../../../src/shared/work-plan';

interface Props {
  sessionId: string | null;
  running: boolean;
  files: Array<{ path: string; action: string }>;
  onOpenFile: (path: string) => void;
  onPlanMode: (enabled: boolean) => void;
}

/** Persistent work summary; polling also reconciles missed socket events. */
export default function WorkPlanPanel({ sessionId, running, files, onOpenFile, onPlanMode }: Props) {
  const [state, setState] = useState<(WorkPlanState & { planMode?: boolean }) | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  // Notice is tied to the revision it was written for; a newer revision retires it.
  const [notice, setNotice] = useState<{ text: string; revision: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  // Plan-mode value we asked for; button stays disabled until the poll reflects it.
  const [requestedPlanMode, setRequestedPlanMode] = useState<boolean | null>(null);
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1100);
  // Parent remounts this panel per session (key=sessionId), so no reset-in-effect is needed.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!sessionId) return;
    const read = async () => {
      // Hidden tab: skip the request, keep the schedule.
      if (typeof document !== 'undefined' && document.hidden) { timer = setTimeout(read, 3000); return; }
      try {
        const result = workPlanViewSchema.parse(await api.get<unknown>(`/sessions/${sessionId}/plan`));
        if (!disposed) { setState(previous => previous && previous.revision > result.revision ? previous : result); setError(''); }
      } catch (e) {
        if (!disposed) setError(e instanceof ZodError ? 'The server returned a plan this version of the app cannot read.' : e instanceof Error ? e.message : 'Could not load plan');
      } finally {
        if (!disposed) timer = setTimeout(read, 3000);
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId, refresh]);
  const plan = state?.current;
  const done = plan?.steps.filter(step => step.status === 'done').length ?? 0;
  const current = plan?.steps.find(step => step.status === 'working' || step.status === 'blocked');
  const results = Array.from(new Map(files.map(file => [file.path, file])).values());
  async function submitFeedback() {
    if (!sessionId || !plan || !state || !feedback.trim()) return;
    setSending(true); setFeedbackError(''); setNotice(null);
    try {
      const updated = workPlanStateSchema.parse(await api.post<WorkPlanState>(`/sessions/${sessionId}/plan/feedback`, {
        text: feedback.trim(), planId: plan.id, revision: state.revision,
      }));
      setState(previous => previous && previous.revision > updated.revision ? previous : { ...updated, planMode: previous?.planMode });
      setFeedback(''); setEditing(false);
      setNotice({ text: 'Feedback saved. It remains pending until Octipus handles it.', revision: updated.revision });
    } catch (e) { setFeedbackError(e instanceof Error ? e.message : 'Feedback was not saved'); }
    finally { setSending(false); }
  }
  return <section className="work-plan-panel p-4 space-y-4" aria-label="Work plan">
    <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span><span className="block text-xs uppercase tracking-widest text-primary mb-1">Plan</span>
        <span className="block text-sm font-semibold">{plan ? `${done} of ${plan.steps.length} steps done` : 'Follow the work'}</span>
        {!open && current && <span className="block text-xs text-on-surface-variant mt-1">{current.title}</span>}
      </span><span className="text-xs text-primary">{open ? 'Collapse' : 'Open'}</span>
    </button>
    {error && <div role="status" className="text-xs text-warning">Plan unavailable. Previously loaded progress may be stale. {error}
      <button type="button" className="flex gap-1 underline mt-2" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={12} />Retry plan</button></div>}
    {open && <>
      {sessionId && state && <div className="rounded-lg bg-background/50 p-3 text-xs text-on-surface-variant">
        <p>{state.planMode ? 'Plan first · implementation is waiting for your decision.' : 'Normal work · Octipus may proceed within your permissions.'}</p>
        <button type="button" disabled={running || !!error || (requestedPlanMode !== null && requestedPlanMode !== !!state.planMode)} onClick={() => { setRequestedPlanMode(!state.planMode); onPlanMode(!state.planMode); }} className="mt-2 text-primary underline disabled:opacity-50">{state.planMode ? 'Allow implementation' : 'Enable plan-first mode'}</button>
        {state.planMode && <p className="mt-2">After allowing implementation, send a message to start. Tool permissions still apply.</p>}
      </div>}
      {!sessionId ? <p className="text-sm text-on-surface-variant">Describe an outcome to start. Plans for substantial work will appear here.</p>
        : !state && !error ? <p className="text-sm text-on-surface-variant">Loading plan…</p>
        : !plan && !error ? <p className="text-sm text-on-surface-variant">No plan published yet. Simple requests may not need one.</p> : null}
      {plan && <>
        <div><h2 className="text-base font-semibold">{plan.title}</h2><p className="text-sm text-on-surface-variant mt-2">{plan.goal}</p></div>
        <PlanSteps plan={plan} />
        {current?.status === 'working' && !running && <p className="text-xs text-warning">Last reported step is still open. This does not confirm execution is running.</p>}
        <p className="text-xs text-on-surface-variant">Steps report work progress. Expand a step for its evidence and checks.</p>
        <button type="button" className="flex items-center gap-2 text-sm text-primary rounded-lg border border-outline-variant px-3 py-2" onClick={() => setEditing(!editing)} aria-expanded={editing}><MessageSquare size={15} />Adjust plan</button>
        {editing && <form onSubmit={e => { e.preventDefault(); void submitFeedback(); }} className="space-y-2">
          <label htmlFor="plan-feedback" className="text-sm">What should change?</label>
          <textarea id="plan-feedback" value={feedback} maxLength={2000} onChange={e => setFeedback(e.target.value)} className="w-full min-h-24 rounded-lg border border-outline-variant bg-background p-3 text-sm" placeholder="Keep the current API and add a timeout check…" />
          <p className="text-xs text-on-surface-variant">Running tools may finish first. If the turn has ended, send a message to continue with your feedback.</p>
          <button disabled={sending || !feedback.trim() || !!error} className="rounded-lg bg-primary text-on-primary px-3 py-2 text-sm disabled:opacity-50">{sending ? 'Saving…' : 'Send feedback'}</button>
        </form>}
        {feedbackError && <p role="alert" className="text-sm text-error">{feedbackError}</p>}
        {notice && notice.revision === state?.revision && <p role="status" className="text-xs text-primary">{notice.text}</p>}
        {!!plan.feedback.length && <div className="space-y-3"><h3 className="text-xs uppercase tracking-widest text-on-surface-variant">Feedback</h3>{plan.feedback.map(item => <div key={item.id} className="rounded-lg border border-outline-variant p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.text}</p><p className="text-xs text-primary mt-2">{item.status === 'pending' ? 'Pending' : item.status === 'applied' ? 'Applied to plan' : 'Needs clarification'}</p>
          {item.response && <p className="text-xs text-on-surface-variant mt-1">{item.response}</p>}
        </div>)}</div>}
        <details className="text-xs text-on-surface-variant"><summary className="cursor-pointer">Revisions · {plan.history.length}</summary><ul className="space-y-2 mt-2">{plan.history.slice().reverse().map(h => <li key={h.revision}>v{h.revision} · {h.summary}</li>)}</ul></details>
      </>}
      <div className="border-t border-outline-variant pt-4"><h3 className="text-xs uppercase tracking-widest text-primary mb-3">Results</h3>
        {!results.length && <p className="text-sm text-on-surface-variant">Files will appear here as work produces them. Sources and check outcomes belong with their plan steps.</p>}
        {results.map(file => <div key={file.path} className="mb-2 min-w-0">
          {/delete/i.test(file.action) ? <span className="text-sm break-all">{file.path} · Deleted</span> : <button type="button" className="text-sm text-primary text-left break-all hover:underline" onClick={() => onOpenFile(file.path)}>{file.path}</button>}
        </div>)}
      </div>
      {!!state?.previous.length && <details className="text-xs text-on-surface-variant"><summary className="cursor-pointer">Previous plans · {state.previous.length}</summary>{state.previous.slice().reverse().map(old => <details className="mt-3" key={old.id}><summary className="cursor-pointer">{old.title}</summary><div className="mt-2"><PlanSteps plan={old} /></div></details>)}</details>}
    </>}
  </section>;
}
function PlanSteps({ plan }: { plan: WorkPlan }) {
  return <ol className="space-y-2">{plan.steps.map(step => <li key={step.id} className={`rounded-xl border p-3 ${step.status === 'working' ? 'border-primary/50 bg-primary-container/40' : 'border-outline-variant/60'}`}>
    {/* Keep the native disclosure marker: flex lives on an inner span, not on <summary>. */}
    <details><summary className="cursor-pointer text-sm"><span className="inline-flex items-start gap-2 align-top">
      {step.status === 'done' ? <Check size={16} className="text-primary shrink-0 mt-0.5" /> : step.status === 'working' ? <Loader2 size={16} className="text-primary shrink-0 mt-0.5" /> : <Circle size={14} className="shrink-0 mt-1 text-on-surface-variant" />}
      <span className="min-w-0 break-words"><span>{step.title}</span><span className="block text-xs text-on-surface-variant mt-1 capitalize">{step.status === 'done' ? 'Work completed' : step.status}</span></span>
    </span></summary><p className="text-xs text-on-surface-variant mt-3 whitespace-pre-wrap break-words">{step.evidence || 'No evidence or checks recorded yet.'}</p></details>
  </li>)}</ol>;
}
