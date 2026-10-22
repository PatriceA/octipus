'use client';

import { CheckCircle2, Circle, ExternalLink, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ApiCall, OnboardingState, PlanStep } from '../../../src/shared/onboarding/types';

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
interface StepResult { status: StepStatus; message?: string }

/** A route answering 200 with `{ error }` or `{ success: false }` did not do the thing either. */
function failure(res: unknown): string | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as { error?: unknown; success?: unknown };
  if (typeof r.error === 'string' && r.error) return r.error;
  if (r.success === false) return 'The check did not pass';
  return null;
}

async function call(c: ApiCall, extra?: Record<string, unknown>): Promise<unknown> {
  const body = extra ? { ...(c.body as object | undefined), ...extra } : c.body;
  switch (c.method) {
    case 'GET': return api.get(c.path);
    case 'POST': return api.post(c.path, body);
    case 'PUT': return api.put(c.path, body);
    case 'PATCH': return api.patch(c.path, body);
    case 'DELETE': return api.delete(c.path);
  }
}

function connected(step: Extract<PlanStep, { kind: 'connect' }>, s: OnboardingState): boolean {
  if ('mailbox' in step.doneWhen) return Boolean(s.mailbox);
  const id = step.doneWhen.connector;
  return Boolean(s.connectors.find((c) => c.id === id)?.connected);
}

const icon = (status: StepStatus) => {
  switch (status) {
    case 'done': return <CheckCircle2 className="w-4 h-4 text-tertiary" aria-label="done" />;
    case 'failed': return <XCircle className="w-4 h-4 text-error" aria-label="failed" />;
    case 'skipped': return <MinusCircle className="w-4 h-4 text-on-surface-variant" aria-label="skipped" />;
    case 'running': return <Loader2 className="w-4 h-4 animate-spin text-primary" aria-label="running" />;
    case 'waiting': return <Circle className="w-4 h-4 text-warning" aria-label="waiting for you" />;
    default: return <Circle className="w-4 h-4 text-on-surface-variant/50" aria-label="not started" />;
  }
};

/**
 * Runs the plan, one step at a time, through the ordinary routes. A failed
 * step stops only the steps that depend on it; a step that needs the person
 * (a sign-in, a code, something elsewhere) waits for them, and can be skipped.
 */
export function PlanRunner({ steps, onFinished }: { steps: PlanStep[]; onFinished: (results: Record<string, StepResult>) => void }) {
  const [results, setResults] = useState<Record<string, StepResult>>(() => Object.fromEntries(steps.map((s) => [s.id, { status: 'pending' as StepStatus }])));
  const [index, setIndex] = useState(0);
  const [code, setCode] = useState('');
  const started = useRef(-1);
  const set = useCallback((id: string, r: StepResult) => setResults((prev) => ({ ...prev, [id]: r })), []);
  const next = useCallback(() => setIndex((i) => i + 1), []);

  const current = steps[index];

  // One step at a time: each index runs once, then moves the index on (or
  // waits for the person). Async, so its state updates land after the effect.
  const runStep = async (i: number) => {
    const step = steps[i];
    if (!step) {
      onFinished(results);
      return;
    }
    const blocked = step.dependsOn?.find((d) => results[d] && results[d].status !== 'done');
    if (blocked) {
      set(step.id, { status: 'skipped', message: `Skipped: "${steps.find((s) => s.id === blocked)?.title}" did not finish.` });
      next();
      return;
    }
    if (step.kind === 'done') {
      set(step.id, { status: 'done', message: 'Already set up.' });
      next();
      return;
    }
    if (step.kind !== 'api') {
      set(step.id, { status: 'waiting' });
      return;
    }
    set(step.id, { status: 'running' });
    try {
      const err = failure(await call(step.call));
      set(step.id, err ? { status: 'failed', message: err } : { status: 'done', message: step.reveal });
    } catch (err) {
      set(step.id, { status: 'failed', message: (err as Error).message });
    }
    next();
  };

  useEffect(() => {
    if (started.current === index) return;
    started.current = index;
    void Promise.resolve().then(() => runStep(index));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per step index
  }, [index]);

  const finishWaiting = (status: StepStatus, message?: string) => {
    if (!current) return;
    set(current.id, { status, message });
    setCode('');
    next();
  };

  const connect = async (step: Extract<PlanStep, { kind: 'connect' }>) => {
    try {
      const res = (await call(step.start)) as { url?: string; error?: string };
      if (!res?.url) throw new Error(res?.error || 'No sign-in address came back');
      const popup = window.open(res.url, 'onboarding-connect', 'width=600,height=700,left=200,top=100');
      const watch = setInterval(async () => {
        if (popup && !popup.closed) return;
        clearInterval(watch);
        const state = await api.get<OnboardingState>('/onboarding').catch(() => null);
        if (state && connected(step, state)) finishWaiting('done');
        else set(step.id, { status: 'waiting', message: 'Not connected yet. Try again, or skip it and connect later.' });
      }, 1000);
    } catch (err) {
      set(step.id, { status: 'waiting', message: (err as Error).message });
    }
  };

  const submitCode = async (step: Extract<PlanStep, { kind: 'code' }>) => {
    try {
      const res = await call({ method: step.call.method, path: step.call.path }, { [step.call.field]: code.trim() });
      const err = failure(res);
      if (err) set(step.id, { status: 'waiting', message: err });
      else finishWaiting('done');
    } catch (err) {
      set(step.id, { status: 'waiting', message: (err as Error).message });
    }
  };

  return (
    <ol className="space-y-2" aria-label="Setting up">
      {steps.map((step, i) => {
        const r = results[step.id];
        const active = i === index && r?.status === 'waiting';
        return (
          <li key={step.id} className="rounded-lg border border-outline-variant/30 px-3 py-2" data-step={step.id} data-status={r?.status}>
            <div className="flex items-start gap-2">
              <span className="mt-0.5">{icon(r?.status ?? 'pending')}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-on-surface">{step.title}</p>
                {step.detail && <p className="text-xs text-on-surface-variant">{step.detail}</p>}
                {r?.message && (
                  <p className={`text-xs mt-1 ${r.status === 'failed' ? 'text-error' : r.status === 'done' ? 'text-on-surface font-mono' : 'text-on-surface-variant'}`}>{r.message}</p>
                )}
                {active && step.kind === 'connect' && (
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => connect(step)} className="rounded-full bg-primary px-3 py-1 text-xs text-on-primary">Connect</button>
                    <button type="button" onClick={() => finishWaiting('skipped', 'Skipped: connect it later.')} className="text-xs text-on-surface-variant underline">Skip</button>
                  </div>
                )}
                {active && step.kind === 'code' && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-on-surface-variant">{step.prompt}</p>
                    <div className="flex gap-2">
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        aria-label="Link code"
                        className="w-32 rounded-md border border-outline-variant/40 bg-surface px-2 py-1 text-sm font-mono uppercase"
                      />
                      <button type="button" disabled={code.trim().length < 6} onClick={() => submitCode(step)} className="rounded-full bg-primary px-3 py-1 text-xs text-on-primary disabled:opacity-50">Link</button>
                      <button type="button" onClick={() => finishWaiting('skipped', 'Skipped: link it later under Settings → Channels.')} className="text-xs text-on-surface-variant underline">Skip</button>
                    </div>
                  </div>
                )}
                {active && step.kind === 'todo' && (
                  <div className="mt-2 flex gap-3 text-xs">
                    <a href={step.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">Open <ExternalLink className="w-3 h-3" /></a>
                    <button type="button" onClick={() => finishWaiting('done', 'Done.')} className="text-on-surface underline">Done</button>
                    <button type="button" onClick={() => finishWaiting('skipped', 'Left for later.')} className="text-on-surface-variant underline">Later</button>
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
