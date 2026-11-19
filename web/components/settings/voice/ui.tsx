'use client';

import { Loader2 } from 'lucide-react';
import { cloneElement, type ReactElement, type ReactNode, useId } from 'react';

/** The small pieces every section of the Voice page is built from. */

export const inputCls =
  'w-full bg-surface-container-high border border-outline-variant rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary disabled:opacity-50';
export const primaryBtn =
  'inline-flex items-center gap-1.5 px-3 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary-dim disabled:opacity-50';
export const quietBtn =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary/10 text-primary rounded-lg hover:bg-primary/20 disabled:opacity-50';
export const dangerBtn =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-error/10 text-error rounded-lg hover:bg-error/20 disabled:opacity-50';

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function Section({ title, description, testId, children }: { title: string; description?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section className="bg-surface-container rounded-xl p-4 space-y-4" data-testid={testId} aria-label={title}>
      <div>
        <h3 className="text-base font-semibold text-on-surface">{title}</h3>
        {description && <p className="text-xs text-on-surface-variant mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold text-on-surface">{children}</h4>;
}

/** An error where it happened, in the page. */
export function InlineError({ message, testId }: { message: string | null | undefined; testId?: string }) {
  if (!message) return null;
  return (
    <p role="alert" data-testid={testId} className="text-xs text-error bg-error/10 px-2 py-1.5 rounded break-words">
      {message}
    </p>
  );
}

/**
 * A labelled control. The label names the control and nothing else (the hint
 * describes it), so a select's chosen option or a hint never becomes part of
 * the control's name.
 */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactElement<{ id?: string; 'aria-describedby'?: string }> }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-on-surface">{label}</label>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && <span id={hintId} className="block text-xs text-on-surface-variant">{hint}</span>}
    </div>
  );
}

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-xs text-on-surface">
      <input type="checkbox" className="accent-primary" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function Busy({ on }: { on: boolean }) {
  return on ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : null;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'primary' }) {
  const cls = tone === 'good' ? 'bg-tertiary/15 text-tertiary' : tone === 'primary' ? 'bg-primary/15 text-primary' : 'bg-surface-container-high text-on-surface-variant';
  return <span className={`px-1.5 py-0.5 text-[11px] rounded-full ${cls}`}>{children}</span>;
}
