'use client';

/**
 * Input components of a view (spec §2.6). Each is controlled by the data
 * model and writes through its `@path`; each has a label element. After an
 * answer is sent they are read-only until **Change answer**.
 */
import { type ReactNode, useEffect, useId, useState } from 'react';
import {
  actionSteps,
  componentEventSteps,
  formatValue,
  isJsonObject,
  isTruthy,
  type JsonValue,
  jsonEqual,
  toNumber,
  valueToText,
} from '../../../../../src/shared/inline-ui/view';
import { cn } from '@/lib/utils';
import { type NodeProps, useViewRuntime } from './runtime';
import { useBinding } from './view';

const LABEL = 'block text-xs font-medium text-on-surface-variant mb-1';
const FIELD = 'w-full rounded-md border border-outline-variant bg-surface-container-high px-2.5 py-1.5 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus:outline-none focus:border-primary read-only:opacity-80 disabled:opacity-50';

/** The text of a number as an input shows it; empty for none. */
function numberText(value: JsonValue | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** What typed text means: null for empty, a finite number, or undefined when it is not one (yet). */
function parseNumber(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function TextField({ c, scope }: NodeProps<'TextField'>) {
  const rt = useViewRuntime();
  const id = useId();
  const { current, write } = useBinding(c.value, scope);
  const variant = c.variant ?? 'short';
  const label = (
    <label htmlFor={id} className={LABEL}>
      {c.label}{c.required && <span className="text-error" aria-hidden> *</span>}
    </label>
  );
  if (variant === 'number') return <NumberField id={id} label={label} c={c} current={current} write={write} />;
  const common = {
    id,
    value: valueToText(current, rt.format),
    placeholder: c.placeholder,
    required: c.required,
    readOnly: rt.readOnly,
    disabled: rt.inert,
    className: FIELD,
  };
  return (
    <div className="min-w-0">
      {label}
      {variant === 'long'
        ? <textarea {...common} rows={3} onChange={(e) => write(e.target.value)} />
        : <input {...common} type="text" onChange={(e) => write(e.target.value)} />}
    </div>
  );
}

/**
 * A number field keeps the text as typed ("1." on the way to "1.5") and
 * writes a number only when it parses and is within min/max; never NaN.
 */
function NumberField({ id, label, c, current, write }: {
  id: string;
  label: ReactNode;
  c: NodeProps<'TextField'>['c'];
  current: JsonValue | undefined;
  write: (v: JsonValue) => void;
}) {
  const rt = useViewRuntime();
  const hintId = useId();
  const [text, setText] = useState(() => numberText(current));
  // The model changed from elsewhere (Reset, a button's `set`): show it, unless the text already means it.
  const [seen, setSeen] = useState(current);
  if (!jsonEqual(seen ?? null, current ?? null)) {
    setSeen(current);
    if (!jsonEqual(parseNumber(text) ?? null, current ?? null)) setText(numberText(current));
  }
  const parsed = parseNumber(text);
  const outOfRange = typeof parsed === 'number' && ((c.min !== undefined && parsed < c.min) || (c.max !== undefined && parsed > c.max));
  const problem = parsed === undefined ? 'Enter a number.'
    : outOfRange ? (c.min !== undefined && c.max !== undefined ? `Enter a number from ${c.min} to ${c.max}.` : c.min !== undefined ? `Enter ${c.min} or more.` : `Enter ${c.max} or less.`)
    : null;
  // The data model keeps the last valid number meanwhile: an answer now would
  // send a value the field does not show, so it waits until this is fixed.
  const { reportNumber } = rt;
  const bad = problem !== null && !rt.readOnly && !rt.inert;
  useEffect(() => {
    reportNumber(id, bad ? c.label : null);
    return () => reportNumber(id, null);
  }, [reportNumber, id, bad, c.label]);

  const onChange = (next: string) => {
    setText(next);
    const n = parseNumber(next);
    if (n === undefined) return;
    if (typeof n === 'number' && ((c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max))) return;
    write(n);
  };

  return (
    <div className="min-w-0">
      {label}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={c.placeholder}
        required={c.required}
        readOnly={rt.readOnly}
        disabled={rt.inert}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD, 'tabular-nums', problem && 'border-error')}
      />
      {problem && <p id={hintId} className="mt-1 text-[11px] text-error">{problem}</p>}
    </div>
  );
}

export function Slider({ c, scope }: NodeProps<'Slider'>) {
  const rt = useViewRuntime();
  const id = useId();
  const { current, write } = useBinding(c.value, scope);
  const n = toNumber(current);
  const held = Number.isFinite(n);
  const value = held ? Math.max(c.min, Math.min(c.max, n)) : c.min;
  const shown = formatValue(value, c.format, rt.format);
  // No number at the path (a template item, a view stored before the lint
  // asked for one): the slider shows its minimum, so the data model holds it
  // too — the display, expressions and the answer agree. Once, on mount.
  const fill = !held && !rt.inert && !rt.readOnly;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (fill) write(value); }, []);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={LABEL}>{c.label}</label>
        <output htmlFor={id} className="text-sm font-medium tabular-nums text-on-surface">{shown}</output>
      </div>
      <input
        id={id}
        type="range"
        min={c.min}
        max={c.max}
        step={c.step ?? 'any'}
        value={value}
        aria-valuetext={shown}
        disabled={rt.readOnly || rt.inert}
        onChange={(e) => write(Number(e.target.value))}
        className="w-full accent-primary disabled:opacity-60"
      />
    </div>
  );
}

export function CheckBox({ c, scope }: NodeProps<'CheckBox'>) {
  const rt = useViewRuntime();
  const id = useId();
  const { current, write } = useBinding(c.value, scope);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <input id={id} type="checkbox" checked={isTruthy(current ?? null)} disabled={rt.readOnly || rt.inert} onChange={(e) => write(e.target.checked)} className="h-4 w-4 accent-primary" />
      <label htmlFor={id} className="text-sm text-on-surface">{c.label}</label>
    </div>
  );
}

interface Option { label: string; value: string | number | boolean; description?: string }

function readOptions(value: JsonValue | undefined): Option[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((o) => {
    if (!isJsonObject(o) || (typeof o.value !== 'string' && typeof o.value !== 'number' && typeof o.value !== 'boolean')) return [];
    return [{ label: valueToText(o.label ?? o.value), value: o.value, ...(typeof o.description === 'string' ? { description: o.description } : {}) }];
  });
}

export function ChoicePicker({ c, r, scope }: NodeProps<'ChoicePicker'>) {
  const rt = useViewRuntime();
  const id = useId();
  const { current, write } = useBinding(c.value, scope);
  const options = readOptions(r.options);
  const multiple = !!c.multiple;
  const chosen = (o: Option) => (multiple ? Array.isArray(current) && current.some((v) => jsonEqual(v, o.value)) : jsonEqual(current ?? null, o.value));
  const pick = (o: Option) => {
    if (!multiple) { write(o.value); return; }
    const list = Array.isArray(current) ? current : [];
    write(chosen(o) ? list.filter((v) => !jsonEqual(v, o.value)) : [...list, o.value]);
  };
  const off = rt.readOnly || rt.inert;
  // A multi-select list box is hard to use; several choices show as chips instead.
  const display = c.display === 'select' && multiple ? 'chips' : c.display ?? 'radio';

  if (display === 'select') {
    const index = options.findIndex(chosen);
    return (
      <div className="min-w-0">
        <label htmlFor={id} className={LABEL}>{c.label ?? 'Choose one'}</label>
        <select id={id} value={index < 0 ? '' : String(index)} disabled={off} onChange={(e) => { const o = options[Number(e.target.value)]; if (o) pick(o); }} className={cn(FIELD, 'pr-8')}>
          {index < 0 && <option value="" disabled>Choose…</option>}
          {options.map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
        </select>
      </div>
    );
  }

  if (display === 'chips') {
    return (
      <div className="min-w-0" role="group" aria-labelledby={c.label ? `${id}-label` : undefined} aria-label={c.label ? undefined : 'Choices'}>
        {c.label && <span id={`${id}-label`} className={LABEL}>{c.label}</span>}
        <div className="flex flex-wrap gap-1.5">
          {options.map((o, i) => {
            const on = chosen(o);
            return (
              <button
                key={i}
                type="button"
                aria-pressed={on}
                disabled={off}
                title={o.description}
                onClick={() => pick(o)}
                className={cn('rounded-full border px-3 py-1 text-sm disabled:opacity-60', on ? 'border-primary bg-primary-container text-on-primary-container' : 'border-outline-variant text-on-surface hover:bg-surface-container-high')}
              >{o.label}</button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <fieldset className="min-w-0 border-0 p-0 m-0">
      {c.label && <legend className={LABEL}>{c.label}</legend>}
      <div className="flex flex-col gap-1.5">
        {options.map((o, i) => {
          const on = chosen(o);
          const optionId = `${id}-${i}`;
          return (
            <label
              key={i}
              htmlFor={optionId}
              className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2 cursor-pointer', on ? 'border-primary bg-primary-container/40' : 'border-outline-variant/60 hover:bg-surface-container-high', off && 'cursor-default opacity-80')}
            >
              <input id={optionId} type={multiple ? 'checkbox' : 'radio'} name={id} checked={on} disabled={off} onChange={() => pick(o)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
              <span className="min-w-0">
                <span className="block text-sm text-on-surface break-words">{o.label}</span>
                {o.description && <span className="block text-xs text-on-surface-variant break-words">{o.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function DateTimeInput({ c, scope }: NodeProps<'DateTimeInput'>) {
  const rt = useViewRuntime();
  const id = useId();
  const { current, write } = useBinding(c.value, scope);
  const date = c.enableDate !== false;
  const time = !!c.enableTime;
  const type = date && time ? 'datetime-local' : time ? 'time' : 'date';
  // What each input type reads and writes: 2026-11-22, 14:30, 2026-11-22T14:30.
  const fit = (v: string | undefined) => (v === undefined ? undefined : type === 'date' ? v.slice(0, 10) : type === 'time' ? (v.includes('T') ? v.split('T')[1] : v).slice(0, 5) : v.slice(0, 16));
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>{c.label}</label>
      <input
        id={id}
        type={type}
        value={fit(typeof current === 'string' ? current : '') ?? ''}
        min={fit(c.min)}
        max={fit(c.max)}
        readOnly={rt.readOnly}
        disabled={rt.inert}
        onChange={(e) => write(e.target.value === '' ? null : e.target.value)}
        className={cn(FIELD, 'scheme-light dark:scheme-dark')}
      />
    </div>
  );
}

const BUTTON_VARIANT = {
  primary: 'bg-primary text-on-primary hover:bg-primary-dim',
  default: 'border border-outline-variant bg-surface-container-high text-on-surface hover:bg-surface-container-highest',
  borderless: 'text-primary hover:bg-surface-container-high',
  danger: 'bg-error text-on-error hover:bg-error-dim',
} as const;

export function Button({ c, r, scope }: NodeProps<'Button'>) {
  const rt = useViewRuntime();
  const answers = componentEventSteps(c).length > 0;
  // A button that only changes the data model is an input: read-only after the answer, too.
  const writes = actionSteps(c.action).some((step) => 'set' in step);
  const blocked = answers ? rt.eventBlock
    : rt.inert ? 'Not available here'
    : writes && rt.readOnly ? 'Answer sent — choose Change answer to change it'
    : null;
  const off = isTruthy(r.disabled ?? null);
  return (
    <button
      type="button"
      disabled={off || !!blocked}
      title={blocked ?? undefined}
      aria-describedby={blocked ? rt.eventBlockId : undefined}
      onClick={() => rt.click(c.id, scope)}
      className={cn('inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed', BUTTON_VARIANT[c.variant ?? 'default'])}
    >{valueToText(r.label, rt.format)}</button>
  );
}
