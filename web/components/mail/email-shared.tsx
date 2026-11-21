'use client';

import { useEffect, useRef, useState } from 'react';
import type { EmailAddress, EmailFolder, EmailMessage, EmailProvider, EmailTriage, InboxItem } from '../../../src/shared/email';

export type { EmailAddress, EmailFolder, EmailMessage, EmailProvider, EmailTriage, InboxItem };

export const providerLabel = (provider: EmailProvider) => (provider === 'google' ? 'Gmail' : 'Outlook');

export const who = (a: EmailAddress | undefined) => a?.name || a?.email || '(unknown sender)';
export const addressList = (list: EmailAddress[] | undefined) => (list ?? []).map((a) => a.email).filter(Boolean).join(', ');

/** "14:05" today, "Nov 3" this year, a short date before that. */
export function shortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (!iso || !Number.isFinite(+date)) return '';
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
}

/** One list row: a conversation's newest loaded message, with the ids of all its loaded messages. */
export interface Conversation {
  key: string;
  latest: InboxItem;
  ids: string[];
  unread: boolean;
  starred: boolean;
}

/** Group loaded rows by conversation, keeping the order of each conversation's newest message. */
export function conversations(items: InboxItem[]): Conversation[] {
  const byKey = new Map<string, Conversation>();
  for (const it of items) {
    const key = it.threadId || it.id;
    const found = byKey.get(key);
    if (!found) byKey.set(key, { key, latest: it, ids: [it.id], unread: it.unread, starred: !!it.starred });
    else {
      found.ids.push(it.id);
      found.unread ||= it.unread;
      found.starred ||= !!it.starred;
      // Triage belongs to a message; show the conversation's newest answer.
      if (!found.latest.triage && it.triage) found.latest = { ...found.latest, triage: it.triage };
    }
  }
  return [...byKey.values()];
}

export const priorityTone: Record<EmailTriage['priority'], string> = {
  high: 'bg-error/10 text-error',
  normal: 'bg-surface-container-high text-on-surface-variant',
  low: 'bg-surface-container-high text-on-surface-variant/70',
};

export const sourceLabel: Record<NonNullable<EmailTriage['source']>, string> = {
  owner: 'set by you',
  decision: 'decision model',
  llm: 'LLM',
};

/** Why a mail got its triage, in one line, for a tooltip. */
export function triageWhy(t: EmailTriage): string {
  return [t.source ? `Triage: ${sourceLabel[t.source]}` : '', t.reason ?? ''].filter(Boolean).join(' — ');
}

export const btn = 'inline-flex items-center gap-1.5 rounded-md border border-outline-variant/60 px-2.5 py-1.5 text-sm text-on-surface hover:bg-surface-container-high disabled:opacity-50 disabled:pointer-events-none';
export const btnPrimary = 'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-dim disabled:opacity-50 disabled:pointer-events-none';
export const btnGhost = 'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50 disabled:pointer-events-none';
export const field = 'w-full rounded-md border border-outline-variant/60 bg-surface px-2.5 py-1.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none';

/** Placeholder rows while a list loads: the page keeps its shape. */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden className="divide-y divide-outline-variant/30">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 px-3 py-3 animate-pulse">
          <div className="h-8 w-8 shrink-0 rounded-full bg-surface-container-highest" />
          <div className="flex-1 space-y-2">
            <div className="flex justify-between gap-6"><div className="h-3 w-32 rounded bg-surface-container-highest" /><div className="h-3 w-10 rounded bg-surface-container-high" /></div>
            <div className="h-3 rounded bg-surface-container-high" style={{ width: `${60 + ((i * 17) % 35)}%` }} />
            <div className="h-3 w-2/5 rounded bg-surface-container-high" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * How the server hands over a remote image (REMOTE_IMAGE_ATTR in
 * src/core/html/sanitize.ts): the URL is parked outside `src`. "<" is escaped
 * in sanitized text, so this only ever matches a real image tag.
 */
const BLOCKED_IMAGE = '<img data-remote-src="';
export const hasBlockedImages = (html: string) => html.includes(BLOCKED_IMAGE);

const FRAME_STYLE = 'html{color-scheme:light}body{margin:0;padding:14px 16px;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#20323d;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#265e59}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #cbd6dc;color:#536977}pre{white-space:pre-wrap}';

/**
 * A mail's HTML in a frame of its own: it runs no script (no `allow-scripts`),
 * loads nothing but images, and is drawn on the light page its sender designed
 * it for, whatever theme the app is in. Links open in a new tab.
 */
export function MailHtml({ html, showImages, title }: { html: string; showImages: boolean; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const body = showImages ? html.replaceAll(BLOCKED_IMAGE, '<img src="') : html;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${showImages ? 'https: http: data:' : 'data:'}; style-src 'unsafe-inline'"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const root = frame.contentDocument?.documentElement;
      if (root) setHeight(Math.min(Math.max(root.scrollHeight, 60), 20000));
    };
    const onLoad = () => {
      measure();
      const content = frame.contentDocument?.body;
      if (content && typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(measure); observer.observe(content); }
    };
    frame.addEventListener('load', onLoad);
    if (frame.contentDocument?.readyState === 'complete') onLoad();
    return () => { frame.removeEventListener('load', onLoad); observer?.disconnect(); };
  }, [doc]);
  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="w-full rounded-md border border-outline-variant/40 bg-white"
      style={{ height }}
    />
  );
}
