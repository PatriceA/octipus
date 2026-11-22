'use client';

/** Display components of a view: Text, Stat, Badge, Progress, KeyValue, Link (spec §2.6). */
import { ExternalLink } from 'lucide-react';
import { isSafeInlineUiLink } from '../../../../../src/shared/inline-ui/bridge';
import { formatNumber, isJsonObject, type JsonValue, type Tone, toNumber, valueToText } from '../../../../../src/shared/inline-ui/view';
import { Markdown } from '@/components/ui/markdown-renderer';
import { cn } from '@/lib/utils';
import { type NodeProps, useViewRuntime } from './runtime';

const TONES: readonly Tone[] = ['neutral', 'good', 'warn', 'bad'];

/** A dynamic tone; anything else (a typo in an expression's result) is neutral. */
export function toneOf(value: JsonValue | undefined): Tone {
  return typeof value === 'string' && (TONES as readonly string[]).includes(value) ? (value as Tone) : 'neutral';
}

const TONE_TEXT: Record<Tone, string> = { neutral: 'text-on-surface', good: 'text-tertiary', warn: 'text-warning', bad: 'text-error' };
const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-surface-container-highest text-on-surface-variant',
  good: 'bg-tertiary-container text-on-tertiary-container',
  warn: 'bg-warning-container text-on-warning-container',
  bad: 'bg-error-container text-on-error-container',
};

/** A value shown on its own: numbers with grouping (1,250), everything else as text. */
export function displayValue(value: JsonValue | undefined, format: Parameters<typeof valueToText>[1]): string {
  return typeof value === 'number' ? formatNumber(value, undefined, format) : valueToText(value, format);
}

export function Text({ c, r }: NodeProps<'Text'>) {
  const rt = useViewRuntime();
  const text = valueToText(r.text, rt.format);
  switch (c.variant ?? 'body') {
    case 'heading': return <h4 className="text-base font-semibold text-on-surface break-words">{text}</h4>;
    case 'subheading': return <h5 className="text-sm font-medium text-on-surface break-words">{text}</h5>;
    case 'caption': return <p className="text-xs text-on-surface-variant break-words">{text}</p>;
    case 'label': return <p className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant break-words">{text}</p>;
    default: return <div className="min-w-0 break-words"><Markdown content={text} untrusted={rt.untrusted} /></div>;
  }
}

export function Stat({ r }: NodeProps<'Stat'>) {
  const rt = useViewRuntime();
  const hint = r.hint === undefined ? '' : valueToText(r.hint, rt.format);
  return (
    <div className="rounded-md bg-surface-container-high/70 px-3 py-2 min-w-0 h-full" data-testid="inline-ui-stat">
      <p className="text-xs text-on-surface-variant break-words">{valueToText(r.label, rt.format)}</p>
      <p className={cn('text-xl font-semibold tabular-nums break-words', TONE_TEXT[toneOf(r.tone)])}>{displayValue(r.value, rt.format)}</p>
      {hint && <p className="text-[11px] text-on-surface-variant break-words">{hint}</p>}
    </div>
  );
}

export function Badge({ r }: NodeProps<'Badge'>) {
  const rt = useViewRuntime();
  return <span className={cn('inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium break-words', TONE_BADGE[toneOf(r.tone)])}>{valueToText(r.text, rt.format)}</span>;
}

export function Progress({ c, r }: NodeProps<'Progress'>) {
  const rt = useViewRuntime();
  const max = typeof c.max === 'number' && c.max > 0 ? c.max : 100;
  const raw = toNumber(r.value);
  const value = Number.isFinite(raw) ? Math.max(0, Math.min(max, raw)) : 0;
  const label = r.label === undefined ? '' : valueToText(r.label, rt.format);
  const percent = Math.round((value / max) * 100);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-on-surface-variant break-words">{label}</span>
        <span className="tabular-nums text-on-surface">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label || 'Progress'}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-container-highest"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function KeyValue({ r }: NodeProps<'KeyValue'>) {
  const rt = useViewRuntime();
  const items = Array.isArray(r.items) ? r.items.filter(isJsonObject) : [];
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-on-surface-variant break-words">{valueToText(item.label, rt.format)}</dt>
          <dd className="text-on-surface tabular-nums break-words">{displayValue(item.value, rt.format)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The address a Link may open, or null: the parsed URL's own serialization,
 * and only when its scheme is https. The value can come from what the user
 * typed into the view, so the anchor never receives the raw text.
 */
function httpsHref(url: string): string | null {
  if (!isSafeInlineUiLink(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' ? parsed.href : null;
}

/** A link opens like a markdown link in a reply: a new tab, no opener or referrer, https only. */
export function Link({ r }: NodeProps<'Link'>) {
  const rt = useViewRuntime();
  const text = valueToText(r.text, rt.format);
  const href = httpsHref(valueToText(r.url, rt.format));
  if (!href) return <span className="text-on-surface-variant" title="Not an https: link, so it is not opened">{text}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex items-center gap-1 text-primary underline hover:opacity-80 break-all">
      {text}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}
