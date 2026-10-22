'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { buildPlan } from '../../../src/shared/onboarding/plan';
import { initialAnswers, sectionsFor, storableAnswers, USE_CASES, visibleQuestions } from '../../../src/shared/onboarding/use-cases';
import type { Answers, OnboardingState, PlanStep, UseCaseId } from '../../../src/shared/onboarding/types';
import { PlanRunner, type StepStatus } from './plan-runner';
import { QuestionField } from './question-field';

type Phase = 'choose' | 'questions' | 'review' | 'run' | 'done';

/** A password for a login the guide creates: 16 characters with upper, lower and a digit. */
function newPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${body.slice(0, 13)}Aa7`;
}

/**
 * The onboarding guide (docs/ONBOARDING.md): what will you use Octipus for →
 * a few questions per use case, each saying what is already set up → the list
 * of what the guide will do → it does it, through the ordinary routes, waiting
 * for the person where only they can act (a sign-in, a chat code).
 *
 * On the home page (`variant="home"`) it shows until it is finished or put
 * away; `/onboarding` always shows it, to set up more later.
 */
export function OnboardingGuide({ variant }: { variant: 'home' | 'page' }) {
  const queryClient = useQueryClient();
  const { data: state, error } = useQuery({
    queryKey: ['onboarding'],
    // An older server (or anything that is not the guide's state) shows no guide.
    queryFn: async () => {
      const s = await api.get<OnboardingState>('/onboarding');
      return s && typeof s === 'object' && 'models' in s && 'heartbeat' in s ? { ...s, progress: s.progress ?? {} } : null;
    },
    retry: false,
  });
  const [phase, setPhase] = useState<Phase>('choose');
  const [sectionIndex, setSectionIndex] = useState(0);
  const [useCases, setUseCases] = useState<UseCaseId[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [outcome, setOutcome] = useState<Record<string, { status: StepStatus; message?: string }>>({});
  const loaded = useRef(false);

  // Pick up where the person left off last time.
  useEffect(() => {
    if (!state || loaded.current) return;
    loaded.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the saved progress once, when the server's answer arrives
    if (state.progress.useCases?.length) setUseCases(state.progress.useCases);
    if (state.progress.answers) setAnswers(state.progress.answers);
  }, [state]);

  // Save the answers as they go (secrets stay in this page only).
  useEffect(() => {
    if (!loaded.current || phase === 'choose') return;
    const t = setTimeout(() => {
      void api.put('/onboarding/progress', { useCases, answers: storableAnswers(answers) }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(t);
  }, [answers, useCases, phase]);

  const sections = useMemo(() => sectionsFor(useCases), [useCases]);

  if (error) return variant === 'page' ? <p className="text-sm text-error">{(error as Error).message}</p> : null;
  if (!state) return null;
  const finishedBefore = Boolean(state.progress.completedAt);
  if (variant === 'home' && (state.progress.dismissed || (finishedBefore && phase === 'choose'))) {
    return (
      <p className="text-xs text-on-surface-variant">
        <Link href="/onboarding" className="text-primary underline">Set up Octipus for something else</Link>
      </p>
    );
  }

  const dismiss = async () => {
    await api.put('/onboarding/progress', { dismissed: true }).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
  };

  const start = () => {
    setAnswers((prev) => ({ ...initialAnswers(useCases, state, prev) }));
    setSectionIndex(0);
    setPhase('questions');
  };

  const review = () => {
    setPlan(buildPlan(useCases, answers, state, { newPassword }));
    setPhase('review');
  };

  const finished = async (results: Record<string, { status: StepStatus; message?: string }>) => {
    setOutcome(results);
    setPhase('done');
    // Secrets are spent: clear them from the page.
    setAnswers((prev) => storableAnswers(prev));
    await api.put('/onboarding/progress', { useCases, answers: storableAnswers(answers), completed: true }).catch(() => undefined);
    await queryClient.invalidateQueries();
  };

  const shell = (children: React.ReactNode) => (
    <section aria-label="Set up Octipus" data-testid="onboarding" className="rounded-2xl border border-primary/30 bg-surface-container-low p-5 sm:p-6 space-y-5">
      <header className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-primary mt-0.5 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold">Set up Octipus for what you do</h2>
          <p className="text-sm text-on-surface-variant">
            Answer a few questions; Octipus does the settings for you. Everything can be changed later, and nothing here is required.
          </p>
        </div>
        {variant === 'home' && phase !== 'run' && (
          <button type="button" onClick={dismiss} aria-label="Put the setup guide away" className="text-on-surface-variant hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        )}
      </header>
      {children}
    </section>
  );

  if (phase === 'choose') {
    return shell(
      <>
        <p className="text-sm font-medium">What will you use Octipus for? Pick as many as fit.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {USE_CASES.map((u) => {
            const on = useCases.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => setUseCases((prev) => (on ? prev.filter((x) => x !== u.id) : [...prev, u.id]))}
                className={`text-left rounded-xl border p-4 transition-colors ${on ? 'border-primary bg-primary/10' : 'border-outline-variant/40 hover:border-primary/60'}`}
              >
                <span className="flex items-center gap-2 font-semibold text-on-surface">
                  {on && <Check className="w-4 h-4 text-primary" aria-hidden />} {u.title}
                </span>
                <span className="block mt-1 text-xs text-on-surface-variant">{u.summary}</span>
                <span className="block mt-2 text-[11px] text-on-surface-variant/80">Sets up: {u.sets.join(' · ')}</span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end">
          <button type="button" disabled={useCases.length === 0} onClick={start} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-40">
            Continue <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </>,
    );
  }

  if (phase === 'questions') {
    // One section at a time; a section with nothing to ask (an admin-only one
    // for someone else, with no note) is left out.
    const shown = sections.filter((sec) => visibleQuestions(sec, answers, state).length > 0 || (sec.adminOnly && !state.isAdmin && sec.nonAdminNote));
    const i = Math.min(sectionIndex, shown.length - 1);
    const section = shown[i];
    const last = i >= shown.length - 1;
    return shell(
      <>
        <nav aria-label="Setup steps" className="flex flex-wrap gap-1.5">
          {shown.map((sec, n) => (
            <button
              key={sec.id}
              type="button"
              onClick={() => setSectionIndex(n)}
              aria-current={n === i ? 'step' : undefined}
              className={`rounded-full px-3 py-1 text-xs border ${n === i ? 'border-primary bg-primary/10 text-on-surface' : n < i ? 'border-tertiary/40 text-on-surface-variant' : 'border-outline-variant/40 text-on-surface-variant'}`}
            >
              {n < i ? '✓ ' : ''}{sec.title}
            </button>
          ))}
        </nav>
        {section && (
          <fieldset key={section.id} className="rounded-xl border border-outline-variant/30 p-4 space-y-4" data-section={section.id}>
            <legend className="px-1 text-sm font-semibold text-on-surface">{section.title}</legend>
            <p className="text-xs text-on-surface-variant -mt-2">{section.intro}</p>
            {section.adminOnly && !state.isAdmin
              ? <p className="text-xs text-on-surface-variant">{section.nonAdminNote}</p>
              : visibleQuestions(section, answers, state).map((q) => (
                <QuestionField
                  key={q.id}
                  q={q}
                  value={answers[q.id]}
                  answers={answers}
                  state={state}
                  onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                />
              ))}
          </fieldset>
        )}
        <div className="flex justify-between">
          <button type="button" onClick={() => (i === 0 ? setPhase('choose') : setSectionIndex(i - 1))} className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <button type="button" onClick={() => (last ? review() : setSectionIndex(i + 1))} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
            {last ? 'Review' : 'Next'} <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </>,
    );
  }

  if (phase === 'review') {
    return shell(
      <>
        {plan.length === 0 ? (
          <p className="text-sm text-on-surface-variant">Everything you asked for is already set up. Nothing to do.</p>
        ) : (
          <>
            <p className="text-sm font-medium">Octipus will:</p>
            <ol className="space-y-1.5 list-decimal pl-5 text-sm" aria-label="What the guide will do">
              {plan.map((s) => (
                <li key={s.id} data-plan-step={s.id}>
                  <span className="text-on-surface">{s.title}</span>
                  {s.kind !== 'api' && <span className="ml-2 text-xs text-warning">needs you</span>}
                  {s.detail && <span className="block text-xs text-on-surface-variant">{s.detail}</span>}
                </li>
              ))}
            </ol>
          </>
        )}
        <div className="flex justify-between">
          <button type="button" onClick={() => setPhase('questions')} className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant">
            <ArrowLeft className="w-4 h-4" /> Change answers
          </button>
          <button type="button" onClick={() => (plan.length ? setPhase('run') : finished({}))} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
            {plan.length ? 'Set it up' : 'Finish'} <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </>,
    );
  }

  if (phase === 'run') return shell(<PlanRunner steps={plan} onFinished={finished} />);

  const failed = Object.values(outcome).filter((r) => r.status === 'failed').length;
  const later = Object.values(outcome).filter((r) => r.status === 'skipped').length;
  const revealed = plan.filter((s) => s.kind === 'api' && s.reveal && outcome[s.id]?.status === 'done');
  return shell(
    <>
      <p className="text-sm" role="status">
        {failed === 0 && later === 0 ? 'All set.' : `Done, with ${failed ? `${failed} step${failed === 1 ? '' : 's'} that failed` : ''}${failed && later ? ' and ' : ''}${later ? `${later} left for later` : ''}. Run the guide again any time to finish them.`}
      </p>
      <ul className="space-y-1 text-sm" aria-label="What was done">
        {plan.map((step) => {
          const r = outcome[step.id];
          const status = r?.status ?? 'skipped';
          const mark = status === 'done' ? '✓' : status === 'failed' ? '✗' : '–';
          return (
            <li key={step.id} data-step={step.id} data-status={status} className="flex gap-2">
              <span aria-hidden className={status === 'done' ? 'text-tertiary' : status === 'failed' ? 'text-error' : 'text-on-surface-variant'}>{mark}</span>
              <span className="min-w-0">
                <span className="text-on-surface">{step.title}</span>
                {r?.message && !(step.kind === 'api' && step.reveal) && <span className="block text-xs text-on-surface-variant">{r.message}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {revealed.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs space-y-1">
          <p className="font-medium">Copy these now; they are not shown again:</p>
          {revealed.map((s) => <p key={s.id} className="font-mono">{(s as { reveal?: string }).reveal}</p>)}
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/chat" className="rounded-full bg-primary px-4 py-2 font-semibold text-on-primary">Start working</Link>
        <button type="button" onClick={() => { setPhase('choose'); setPlan([]); }} className="rounded-full border border-outline-variant px-4 py-2">Set up something else</button>
        {variant === 'home' && <button type="button" onClick={dismiss} className="text-on-surface-variant underline">Close the guide</button>}
      </div>
    </>,
  );
}
