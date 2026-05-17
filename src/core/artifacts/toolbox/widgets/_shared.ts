/**
 * Widget helpers — escape, dotted-path resolve, render-result type. Kept
 * private to the widgets folder (filename starts with `_`).
 */

import { escapeHtml as escape } from '../../render';

export interface WidgetRender {
  html: string;
  /** Scoped CSS — concatenated into a single <style> block by the layout. */
  css?: string;
}

export const escapeHtml = escape;

/** Resolve a dotted path on the input. Mirrors render.ts:resolvePath. */
export function path(root: unknown, expr: string): unknown {
  if (!expr) return root;
  const parts = expr.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

export function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}
