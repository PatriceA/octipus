'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BookOpen, Building2, Check, ClipboardList, Code2, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompanionState } from '@/components/companion/companion-avatar';
import { api } from '@/lib/api';
import type { CompanionAppearance } from '../../../src/shared/companion';
import { buildPlan } from '../../../src/shared/onboarding/plan';
import { initialAnswers, sectionsFor, storableAnswers, USE_CASES, visibleQuestions } from '../../../src/shared/onboarding/use-cases';
import type { Answers, AnswerValue, OnboardingProgress, OnboardingState, PlanStep, Question, Section, UseCaseId } from '../../../src/shared/onboarding/types';
import { GuideCompanion } from './guide-companion';
import { PlanRunner, type StepStatus } from './plan-runner';
import { QuestionField } from './question-field';

type Phase = 'choose' | 'questions' | 'review' | 'run' | 'done';

const USE_CASE_ICONS: Record<UseCaseId, typeof Code2> = {
  development: Code2,
  company: Building2,
  product: ClipboardList,
  research: BookOpen,
};

/** What the companion says when a section comes up: its own voice, one line. */
const SECTION_LINES: Record<string, string> = {
  models: 'First, my brain: which AI model should I think with?',
  areas: 'Should I keep some of your work apart from the rest?',
  chat: 'Where can I reach you when you are away from the screen?',
  dev: 'Now, how you build software. Which coding tools should I use?',
  tools: 'Where do your tickets live?',
  company: 'Tell me about your company, so I know what matters to you.',
  product: 'A few things about your product work.',
  mailbox: 'Which account are your mail and meetings in?',
  research: 'Shall I dig into questions for you?',
};

/** What the companion is ready for once a use case is set up ("I'm ready to …"). */
const READY: Record<UseCaseId, string> = {
  development: 'build software with you',
  company: 'help run your company',
  product: 'help with your product',
  research: 'dig into questions for you',
};

/** How long a cheer (or a wince) lasts before the companion settles back. */
const FLASH_MS = 1400;

/** A password for a login the guide creates: 16 characters with upper, lower and a digit. */
function newPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${body.slice(0, 13)}Aa7`;
}

/** An answer that adds something (a yes, a choice, one more item) earns a cheer; text being typed does not. */
function isAddition(q: Question, before: AnswerValue | undefined, after: AnswerValue | undefined): boolean {
  if (q.kind === 'yesno') return after === true && before !== true;
  if (q.kind === 'choice') return after !== before && after !== '' && after !== 'none' && after !== 'skip';
  if (q.kind === 'multi') return Array.isArray(after) && after.length > (Array.isArray(before) ? before.length : 0);
  return false;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The onboarding guide (docs/ONBOARDING.md), hosted by the person's own
 * companion: what will you use Octipus for → a few questions per use case,
 * each saying what is already set up → the companion's plan → it carries it
 * out through the ordinary routes, waiting for the person where only they can
 * act (a sign-in, a chat code). The companion listens while you answer,
 * cheers what you add, works while it sets things up, waits when it needs you
 * and celebrates at the end.
 *
 * On the home page (`variant="home"`) it shows until it is finished or put
 * away; `/onboarding` always shows it, to set up more later.
 */
export function OnboardingGuide({ variant }: { variant: 'home' | 'page' }) {
  const queryClient = useQueryClient();
  // Set by anything the person does here: from then on the guide stays, even once finished.
  const [engaged, setEngaged] = useState(false);
  // The home page first asks only whether the guide is wanted; the full state read
  // (models, mailbox, connectors, CLI tools…) waits until the guide is shown.
  const { data: saved } = useQuery({
    queryKey: ['onboarding', 'progress'],
    queryFn: () => api.get<OnboardingProgress>('/onboarding/progress'),
    enabled: variant === 'home',
    retry: false,
  });
  const hidden = variant === 'home' && Boolean(saved?.dismissed || (saved?.completedAt && !engaged));
  const { data: state, error } = useQuery({
    queryKey: ['onboarding'],
    enabled: variant === 'page' || (saved !== undefined && !hidden),
    // An older server (or anything that is not the guide's state) shows no guide.
    queryFn: async () => {
      const s = await api.get<OnboardingState>('/onboarding');
      return s && typeof s === 'object' && 'models' in s && 'heartbeat' in s ? { ...s, progress: s.progress ?? {} } : null;
    },
    retry: false,
  });
  const { data: persona } = useQuery({
    queryKey: ['persona', 'me'],
    queryFn: () => api.get<{ name?: string; appearance?: CompanionAppearance }>('/persona'),
    retry: false,
  });
  const name = persona?.name || 'Octipus';
  const [phase, setPhase] = useState<Phase>('choose');
  const [sectionIndex, setSectionIndex] = useState(0);
  const [useCases, setUseCases] = useState<UseCaseId[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [outcome, setOutcome] = useState<Record<string, { status: StepStatus; message?: string }>>({});
  const [running, setRunning] = useState<{ title: string; waiting: boolean; done: number } | null>(null);
  const [flash, setFlash] = useState<CompanionState | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  /** A short cheer (or wince), then back to what the phase shows. */
  const react = useCallback((mood: CompanionState) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(mood);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

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

  const onStep = useCallback((step: PlanStep, status: StepStatus, done: number) => {
    if (status === 'running') setRunning({ title: step.title, waiting: false, done });
    else if (status === 'waiting') setRunning({ title: step.title, waiting: true, done });
    else {
      setRunning((prev) => ({ title: prev?.title ?? step.title, waiting: false, done }));
      if (status === 'done' && step.kind !== 'done') react('done');
      if (status === 'failed') react('interrupted');
    }
  }, [react]);

  if (hidden) {
    return (
      <p className="text-xs text-on-surface-variant">
        <Link href="/onboarding" className="text-primary underline">Set up Octipus for something else</Link>
      </p>
    );
  }
  if (error) return variant === 'page' ? <p className="text-sm text-error">{(error as Error).message}</p> : null;
  if (!state) return null;

  const dismiss = async () => {
    await api.put('/onboarding/progress', { dismissed: true }).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
  };

  const toggleUseCase = (id: UseCaseId) => {
    const on = useCases.includes(id);
    setEngaged(true);
    setUseCases((prev) => (on ? prev.filter((x) => x !== id) : [...prev, id]));
    if (!on) react('done');
  };

  const start = () => {
    setEngaged(true);
    setAnswers((prev) => ({ ...initialAnswers(useCases, state, prev) }));
    setSectionIndex(0);
    setPhase('questions');
  };

  const answer = (q: Question, v: AnswerValue | undefined) => {
    if (isAddition(q, answers[q.id], v)) react('done');
    setAnswers((prev) => ({ ...prev, [q.id]: v }));
  };

  const review = () => {
    setPlan(buildPlan(useCases, answers, state, { newPassword }));
    setPhase('review');
  };

  /**
   * Plan again with the same answers against a fresh read. What got done last
   * run stays done: not every step shows up in the state (a stored key, a new
   * login), and doing it twice would make a second one.
   */
  const tryAgain = async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: ['onboarding'], queryFn: () => api.get<OnboardingState>('/onboarding') }).catch(() => state);
    const next = buildPlan(useCases, answers, { ...fresh, progress: fresh.progress ?? {} }, { newPassword });
    setPlan(next.map((st): PlanStep => (st.kind !== 'done' && outcome[st.id]?.status === 'done'
      ? { kind: 'done', id: st.id, title: st.title, detail: st.detail }
      : st)));
    setOutcome({});
    setPhase('review');
  };

  const finished = async (results: Record<string, { status: StepStatus; message?: string }>) => {
    setOutcome(results);
    setRunning(null);
    setPhase('done');
    react(Object.values(results).some((r) => r.status === 'failed') ? 'interrupted' : 'done');
    // Secrets are spent: clear them from the page.
    setAnswers((prev) => storableAnswers(prev));
    await api.put('/onboarding/progress', { useCases, answers: storableAnswers(answers), completed: true }).catch(() => undefined);
    await queryClient.invalidateQueries();
  };

  const shell = (mood: CompanionState, heading: string, line: string, children: React.ReactNode, progress?: { at: number; of: number; label: string }) => (
    <section aria-label="Set up Octipus" data-testid="onboarding" className="rounded-2xl border border-primary/30 bg-surface-container-low p-5 sm:p-6 space-y-5">
      <header className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <GuideCompanion state={flash ?? mood} line={line} name={name} appearance={persona?.appearance} heading={heading} />
        </div>
        {variant === 'home' && phase !== 'run' && (
          <button type="button" onClick={dismiss} aria-label="Put the setup guide away" className="text-on-surface-variant hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        )}
      </header>
      {progress && progress.of > 0 && (
        <div className="space-y-1" aria-label={progress.label}>
          <div className="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.round((progress.at / progress.of) * 100)}%` }} />
          </div>
          <p className="text-[11px] text-on-surface-variant">{progress.label}</p>
        </div>
      )}
      {children}
    </section>
  );

  if (phase === 'choose') {
    const chosen = USE_CASES.filter((u) => useCases.includes(u.id));
    const line = chosen.length === 0
      ? `Hi, I'm ${name}. Tell me what we'll do together and I'll set myself up for it. Pick everything that fits; nothing here is final.`
      : `${chosen.map((u) => u.title).join(' and ')}, lovely. I'll ask a few questions about ${chosen.length === 1 ? 'it' : 'each'}, then show you my plan before I change anything.`;
    return shell(
      chosen.length ? 'listening' : 'idle',
      state.progress.completedAt ? 'Shall we set up something else?' : "Let's set up Octipus together",
      line,
      <>
        <div className="grid gap-3 sm:grid-cols-2">
          {USE_CASES.map((u) => {
            const on = useCases.includes(u.id);
            const Icon = USE_CASE_ICONS[u.id];
            return (
              <button
                key={u.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggleUseCase(u.id)}
                className={`text-left rounded-xl border p-4 transition-colors ${on ? 'border-primary bg-primary/10' : 'border-outline-variant/40 hover:border-primary/60'}`}
              >
                <span className="flex items-center gap-2 font-semibold text-on-surface">
                  <Icon className={`w-4 h-4 ${on ? 'text-primary' : 'text-on-surface-variant'}`} aria-hidden />
                  {u.title}
                  {on && <Check className="w-4 h-4 text-primary ml-auto" aria-hidden />}
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
    // Every question of the section answered by what is already there.
    const sectionSetUp = (sec: Section) => {
      const qs = visibleQuestions(sec, answers, state);
      return qs.length > 0 && qs.every((q) => Boolean(q.alreadyDone?.(state, answers)));
    };
    // One section at a time; a section with nothing to ask (an admin-only one
    // for someone else, with no note) is left out.
    const shown = sections.filter((sec) => visibleQuestions(sec, answers, state).length > 0 || (sec.adminOnly && !state.isAdmin && sec.nonAdminNote));
    const i = Math.min(sectionIndex, shown.length - 1);
    const section = shown[i];
    const last = i >= shown.length - 1;
    const line = !section ? 'Nothing to ask here.'
      : section.adminOnly && !state.isAdmin ? `${SECTION_LINES[section.id] ?? section.intro} Your admin looks after this part.`
        : sectionSetUp(section) ? 'I found this part already set up, so I left your choices as they are. Change anything you like.'
          : SECTION_LINES[section.id] ?? section.intro;
    return shell(
      'listening',
      section?.title ?? 'A few questions',
      line,
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
              {n < i || sectionSetUp(sec) ? '✓ ' : ''}{sec.title}{sectionSetUp(sec) && n >= i ? ' · set up' : ''}
            </button>
          ))}
        </nav>
        {section && (
          <fieldset key={section.id} aria-label={section.title} className="rounded-xl border border-outline-variant/30 p-4 space-y-5" data-section={section.id}>
            {section.adminOnly && !state.isAdmin
              ? <p className="text-xs text-on-surface-variant">{section.nonAdminNote}</p>
              : visibleQuestions(section, answers, state).map((q) => (
                <QuestionField key={q.id} q={q} value={answers[q.id]} answers={answers} state={state} onChange={(v) => answer(q, v)} />
              ))}
          </fieldset>
        )}
        <div className="flex justify-between">
          <button type="button" onClick={() => (i === 0 ? setPhase('choose') : setSectionIndex(i - 1))} className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <button type="button" onClick={() => (last ? review() : setSectionIndex(i + 1))} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
            {last ? 'See my plan' : 'Next'} <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </>,
      { at: i + 1, of: shown.length, label: `Step ${i + 1} of ${shown.length}` },
    );
  }

  if (phase === 'review') {
    const todo = plan.filter((st) => st.kind !== 'done');
    const found = plan.filter((st) => st.kind === 'done');
    const needsYou = todo.filter((st) => st.kind !== 'api').length;
    const line = todo.length === 0
      ? 'Everything you asked for is already in place. Nothing for me to do!'
      : `Here's my plan: ${plural(todo.length, 'thing')} to do${found.length ? `, and ${plural(found.length, 'thing')} I found already in place` : ''}.` +
        `${needsYou ? ` ${needsYou === 1 ? 'One step needs' : `${needsYou} steps need`} you; I'll say when.` : ''} Nothing changes until you say go.`;
    return shell(
      'waiting',
      'My plan',
      line,
      <>
        {todo.length > 0 && (
          <ol className="space-y-1.5 list-decimal pl-5 text-sm" aria-label="What the guide will do">
            {todo.map((st) => (
              <li key={st.id} data-plan-step={st.id}>
                <span className="text-on-surface">{st.title}</span>
                {st.kind !== 'api' && <span className="ml-2 text-xs text-warning">needs you</span>}
                {st.detail && <span className="block text-xs text-on-surface-variant">{st.detail}</span>}
              </li>
            ))}
          </ol>
        )}
        {found.length > 0 && (
          <div>
            <p className="text-sm font-medium">Already set up, left as it is:</p>
            <ul className="mt-1.5 space-y-1 text-sm" aria-label="Already set up">
              {found.map((st) => (
                <li key={st.id} data-plan-step={st.id} className="flex gap-2 text-on-surface-variant">
                  <Check className="w-4 h-4 mt-0.5 text-tertiary shrink-0" aria-hidden />
                  <span>{st.title}{st.detail && <span className="block text-xs">{st.detail}</span>}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-between">
          <button type="button" onClick={() => setPhase('questions')} className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface">
            <ArrowLeft className="w-4 h-4" /> Change answers
          </button>
          <button type="button" onClick={() => (todo.length ? setPhase('run') : finished(Object.fromEntries(found.map((st) => [st.id, { status: 'done' as StepStatus, message: 'Already set up.' }]))))} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary">
            {todo.length ? 'Go, set it up' : 'Finish'} <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </>,
    );
  }

  if (phase === 'run') {
    const line = running?.waiting ? `Your turn: "${running.title}" needs you. I'll wait right here.`
      : running ? `On it: ${running.title.charAt(0).toLowerCase()}${running.title.slice(1)}…` : 'Here we go…';
    return shell(
      running?.waiting ? 'waiting' : 'working',
      'Setting things up',
      line,
      <PlanRunner steps={plan} onFinished={finished} onStep={onStep} />,
      { at: running?.done ?? 0, of: plan.length, label: `${running?.done ?? 0} of ${plan.length} done` },
    );
  }

  const failed = Object.values(outcome).filter((r) => r.status === 'failed').length;
  const later = Object.values(outcome).filter((r) => r.status === 'skipped').length;
  const revealed = plan.filter((s) => s.kind === 'api' && s.reveal && outcome[s.id]?.status === 'done');
  const ready = USE_CASES.filter((u) => useCases.includes(u.id)).map((u) => READY[u.id]);
  const line = failed === 0 && later === 0
    ? `All set! I'm ready to ${ready.length ? ready.join(' and ') : 'help'}. Say hi in the chat whenever you like.`
    : `Mostly done${failed ? `: ${plural(failed, 'step')} didn't work` : ''}${later ? `${failed ? ' and' : ':'} ${later} left for later` : ''}. Run me again any time to finish ${failed + later === 1 ? 'it' : 'them'}.`;
  return shell(
    failed ? 'interrupted' : 'done',
    failed || later ? 'Nearly there' : 'Done',
    line,
    <>
      <ul className="space-y-1 text-sm" aria-label="What was done">
        {plan.map((step) => {
          const r = outcome[step.id];
          const status = r?.status ?? 'skipped';
          const mark = status === 'done' ? '✓' : status === 'failed' ? '✗' : '–';
          const before = step.kind === 'done';
          return (
            <li key={step.id} data-step={step.id} data-status={status} className="flex gap-2">
              <span aria-hidden className={`w-4 shrink-0 text-center ${status === 'done' ? 'text-tertiary' : status === 'failed' ? 'text-error' : 'text-on-surface-variant'}`}>{mark}</span>
              <span className="min-w-0">
                <span className={before ? 'text-on-surface-variant' : 'text-on-surface'}>{step.title}</span>
                {r?.message && !before && !(step.kind === 'api' && step.reveal) && <span className="block text-xs text-on-surface-variant">{r.message}</span>}
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
        {failed + later > 0 && (
          <button type="button" onClick={() => void tryAgain()} className="rounded-full border border-primary/50 px-4 py-2 text-on-surface">Finish the rest</button>
        )}
        <button type="button" onClick={() => { setEngaged(true); setPhase('choose'); setPlan([]); setUseCases([]); }} className="rounded-full border border-outline-variant px-4 py-2">Set up something else</button>
        {variant === 'home' && <button type="button" onClick={dismiss} className="text-on-surface-variant underline">Close the guide</button>}
      </div>
    </>,
  );
}
