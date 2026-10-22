'use client';

import { CheckCircle2 } from 'lucide-react';
import { optionsOf } from '../../../src/shared/onboarding/use-cases';
import type { Answers, AnswerValue, OnboardingState, Question } from '../../../src/shared/onboarding/types';

const input = 'w-full rounded-md border border-outline-variant/40 bg-surface px-3 py-2 text-sm text-on-surface';

/** One question of the onboarding guide, whatever its kind. */
export function QuestionField({ q, value, answers, state, onChange }: {
  q: Question;
  value: AnswerValue | undefined;
  answers: Answers;
  state: OnboardingState;
  onChange: (value: AnswerValue | undefined) => void;
}) {
  const done = q.alreadyDone?.(state, answers);
  const label = <span className="block text-sm font-medium text-on-surface">{q.prompt}</span>;
  const help = q.help && <span className="block text-xs text-on-surface-variant mt-0.5">{q.help}</span>;
  const already = done && (
    <span className="mt-1 flex items-center gap-1 text-xs text-tertiary"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> {done}</span>
  );

  if (q.kind === 'yesno') {
    return (
      <fieldset className="space-y-1" data-question={q.id}>
        <legend className="contents">{label}</legend>
        {help}
        {already}
        <div className="flex gap-2 pt-1" role="radiogroup" aria-label={q.prompt}>
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={value === v}
              onClick={() => onChange(v)}
              className={`rounded-full px-4 py-1.5 text-sm border ${value === v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant/50 hover:border-primary'}`}
            >
              {v ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      </fieldset>
    );
  }

  if (q.kind === 'choice' || q.kind === 'multi') {
    const options = optionsOf(q, state, answers);
    const chosen = q.kind === 'multi' ? (Array.isArray(value) ? value : []) : [value];
    const toggle = (v: string) => {
      if (q.kind === 'choice') return onChange(v);
      const set = new Set(chosen as string[]);
      if (set.has(v)) set.delete(v);
      else set.add(v);
      onChange([...set]);
    };
    return (
      <fieldset className="space-y-1" data-question={q.id}>
        <legend className="contents">{label}</legend>
        {help}
        {already}
        {options.length === 0 && <p className="text-xs text-on-surface-variant">Nothing to choose from on this computer.</p>}
        <div className="grid gap-2 pt-1 sm:grid-cols-2" role={q.kind === 'choice' ? 'radiogroup' : 'group'} aria-label={q.prompt}>
          {options.map((o) => {
            const on = chosen.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role={q.kind === 'choice' ? 'radio' : 'checkbox'}
                aria-checked={on}
                disabled={o.disabled}
                onClick={() => toggle(o.value)}
                className={`text-left rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${on ? 'border-primary bg-primary/10' : 'border-outline-variant/40 hover:border-primary/60'}`}
              >
                <span className="block text-on-surface">{o.label}</span>
                {o.hint && <span className="block text-xs text-on-surface-variant">{o.hint}</span>}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : '';
  return (
    <label className="block space-y-1" data-question={q.id}>
      {label}
      {help}
      {already}
      {q.kind === 'longtext' || q.kind === 'list' ? (
        <textarea
          value={text}
          rows={q.kind === 'list' ? 3 : 3}
          placeholder={q.placeholder}
          onChange={(e) => onChange(q.kind === 'list' ? e.target.value.split('\n') : e.target.value)}
          className={`${input} resize-y`}
        />
      ) : (
        <input
          type={q.kind === 'secret' ? 'password' : 'text'}
          autoComplete={q.kind === 'secret' ? 'off' : undefined}
          value={text}
          placeholder={q.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={input}
        />
      )}
    </label>
  );
}
