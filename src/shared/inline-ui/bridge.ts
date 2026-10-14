/**
 * Messages from an interactive answer's host frame to the chat page, and the
 * page's validator. The page listens to the host frame only (spec S5); the
 * host has already validated what the content frame sent, and the page checks
 * again because the host is just another opaque-origin frame to it.
 */
import { INLINE_UI_REMOVED_ITEMS } from './frames';
import { INLINE_UI_LIMITS } from './limits';

export const INLINE_UI_ERROR_CLASSES = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'Error', 'other'] as const;
export type InlineUiErrorClass = (typeof INLINE_UI_ERROR_CLASSES)[number];
export type InlineUiRemovedItem = (typeof INLINE_UI_REMOVED_ITEMS)[number];

export type InlineUiHostMessage =
  | { type: 'ready' }
  | { type: 'height'; height: number }
  | { type: 'error'; kind: 'script' | 'blank' | 'removed'; errorClass: InlineUiErrorClass; line: number; items: InlineUiRemovedItem[] }
  | { type: 'link'; url: string }
  | { type: 'prompt'; text: string }
  | { type: 'stopped'; reason: 'navigation' | 'flood'; host: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate one message from a host frame; `null` for anything malformed or for another mount. */
export function parseInlineUiHostMessage(data: unknown, channel: string): InlineUiHostMessage | null {
  if (!isObject(data) || data.v !== 1 || data.src !== 'octi-ui-host' || data.ch !== channel) return null;
  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'height':
      return typeof data.height === 'number' && Number.isFinite(data.height) && data.height >= 0
        ? { type: 'height', height: data.height }
        : null;
    case 'error': {
      if (data.kind !== 'script' && data.kind !== 'blank' && data.kind !== 'removed') return null;
      const errorClass = (INLINE_UI_ERROR_CLASSES as readonly unknown[]).includes(data.errorClass) ? data.errorClass as InlineUiErrorClass : 'other';
      const line = typeof data.line === 'number' && Number.isFinite(data.line) ? Math.max(0, Math.floor(data.line)) : 0;
      const items = Array.isArray(data.items)
        ? data.items.filter((x): x is InlineUiRemovedItem => (INLINE_UI_REMOVED_ITEMS as readonly unknown[]).includes(x)).slice(0, 20)
        : [];
      return { type: 'error', kind: data.kind, errorClass, line, items };
    }
    case 'link':
      return typeof data.url === 'string' && isSafeInlineUiLink(data.url) ? { type: 'link', url: data.url } : null;
    case 'prompt': {
      if (typeof data.text !== 'string') return null;
      const text = cleanSuggestedText(data.text);
      return text ? { type: 'prompt', text } : null;
    }
    case 'stopped':
      return data.reason === 'navigation' || data.reason === 'flood'
        ? { type: 'stopped', reason: data.reason, host: typeof data.host === 'string' ? data.host.slice(0, 253) : '' }
        : null;
    default:
      return null;
  }
}

/** An `https:` URL without credentials, at most 2 048 characters. */
export function isSafeInlineUiLink(url: string): boolean {
  if (url.length > 2048) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !!parsed.hostname;
}

const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

/**
 * Suggested-message text as the user will see and send it (S6): control,
 * bidi and zero-width characters removed (newlines and tabs kept), trimmed,
 * capped. Empty means "drop it".
 */
export function cleanSuggestedText(text: string): string {
  return text.replace(CONTROL_RE, '').trim().slice(0, INLINE_UI_LIMITS.promptChars);
}

/** Outcomes the page reports to the model with the user's next message (G3, T13). */
export const INLINE_UI_OUTCOMES = ['script-error', 'blank', 'stopped-navigation', 'stopped-flood', 'froze'] as const;
export type InlineUiOutcome = (typeof INLINE_UI_OUTCOMES)[number];

export interface InlineUiReport {
  id: string;
  outcome: InlineUiOutcome;
  errorClass?: InlineUiErrorClass;
  line?: number;
}

/** The model-facing line for one report — ids and enums only, never text produced by generated code. */
export function inlineUiReportLine(r: InlineUiReport): string {
  const detail = r.outcome === 'script-error' ? ` ${r.errorClass ?? 'other'}${r.line ? ` line ${r.line}` : ''}` : '';
  return `(system note: interactive answer ${r.id} reported ${r.outcome}${detail})`;
}

/** The model-facing line for a message the user sent from a suggestion. */
export function inlineUiProvenanceLine(id: string): string {
  return `(system note: the user sent this message from a suggestion in interactive answer ${id})`;
}
