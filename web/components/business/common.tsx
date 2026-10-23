'use client';

/**
 * Pieces the cases, contacts and records pages share (docs/CASES.md,
 * docs/RECORDS.md): input styles, the error text of a refused write, dates,
 * and the form a record type's fields render as (also the public form page).
 */
import { type ReactNode, useEffect, useState } from 'react';
import type { FieldDef, RecordData } from '../../../src/shared/record-fields';

export const INPUT = 'w-full bg-surface-container rounded-xs px-3 py-2 text-sm text-on-surface border border-outline-variant/30 focus:border-primary/60 outline-none';
export const BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-container-high text-on-surface/80 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
export const PRIMARY = 'inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-full font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
export const LABEL = 'block text-xs font-medium text-on-surface-variant mb-1';
export const CARD = 'bg-surface-container rounded-xs border border-outline-variant/10';

/** The message of a refused write: each of the server's `problems` on its own line, else its error. */
export function problemsOf(err: unknown): string {
  const body = (err as { body?: { error?: unknown; problems?: unknown } } | null)?.body;
  if (Array.isArray(body?.problems) && body.problems.length > 0) return body.problems.join('\n');
  if (typeof body?.error === 'string') return body.error;
  return err instanceof Error ? err.message : String(err);
}

/** `value`, once it has stopped changing for `ms`: a search term sent per pause, not per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The browser's IANA zone, sent with dates so a bare day is the user's day. */
export function browserZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

/** A short local date, with the time when it is not midnight. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  return midnight ? d.toLocaleDateString() : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/** A refused write's text, kept on screen until the next attempt. */
export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="text-sm text-error whitespace-pre-line mt-2">{error}</p>;
}

/** Form values as the inputs hold them: text for every field but booleans. */
export type FieldValues = Record<string, string | boolean>;

/** A record's data as input values. */
export function toFieldValues(fields: readonly FieldDef[], data: RecordData = {}): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = data[f.key];
    out[f.key] = f.type === 'boolean' ? v === true : v === undefined ? '' : String(v);
  }
  return out;
}

/**
 * Input values as the data a write sends: empty text becomes null (clears
 * the field on an update), everything else goes as typed; the server checks
 * and converts it.
 */
export function fromFieldValues(fields: readonly FieldDef[], values: FieldValues): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'boolean') out[f.key] = v === true;
    else out[f.key] = typeof v === 'string' && v.trim() !== '' ? v : null;
  }
  return out;
}

const INPUT_TYPE: Partial<Record<FieldDef['type'], string>> = {
  number: 'number', money: 'number', date: 'date', email: 'email', phone: 'tel', url: 'url',
};

/** The inputs of a record type's fields. */
export function FieldInputs({ fields, values, onChange, disabled }: {
  fields: readonly FieldDef[];
  values: FieldValues;
  onChange: (next: FieldValues) => void;
  disabled?: boolean;
}) {
  const set = (key: string, value: string | boolean) => onChange({ ...values, [key]: value });
  return (
    <div className="space-y-3">
      {fields.map((f) => {
        const id = `field-${f.key}`;
        const label = `${f.label}${f.required ? ' *' : ''}`;
        let input: ReactNode;
        if (f.type === 'boolean') {
          return (
            <label key={f.key} className="flex items-center gap-2 text-sm text-on-surface">
              <input type="checkbox" checked={values[f.key] === true} disabled={disabled} onChange={(e) => set(f.key, e.target.checked)} />
              {label}
              {f.help && <span className="text-xs text-on-surface-variant">{f.help}</span>}
            </label>
          );
        }
        if (f.type === 'textarea') {
          input = <textarea id={id} className={`${INPUT} min-h-24`} value={String(values[f.key] ?? '')} disabled={disabled} required={f.required} onChange={(e) => set(f.key, e.target.value)} />;
        } else if (f.type === 'select') {
          input = (
            <select id={id} className={INPUT} value={String(values[f.key] ?? '')} disabled={disabled} required={f.required} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">—</option>
              {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          );
        } else {
          input = (
            <input
              id={id}
              className={INPUT}
              type={INPUT_TYPE[f.type] ?? 'text'}
              step={f.type === 'money' ? '0.01' : f.type === 'number' ? 'any' : undefined}
              value={String(values[f.key] ?? '')}
              disabled={disabled}
              required={f.required}
              onChange={(e) => set(f.key, e.target.value)}
            />
          );
        }
        return (
          <div key={f.key}>
            <label htmlFor={id} className={LABEL}>{label}</label>
            {input}
            {f.help && <p className="text-xs text-on-surface-variant mt-1">{f.help}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** A stored value as text in a table cell. */
export function showValue(field: FieldDef | undefined, value: RecordData[string] | undefined): string {
  if (value === undefined) return '';
  if (field?.type === 'boolean') return value ? 'yes' : 'no';
  if (field?.type === 'money' && typeof value === 'number') return value.toFixed(2);
  return String(value);
}
