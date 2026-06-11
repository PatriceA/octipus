/**
 * Pure normalization of provider list/message responses into the
 * provider-agnostic InboxItem/EmailMessage shapes (feature #7). Keeping this
 * pure means gmail vs m365 differences are handled in one tested place and the
 * UI never sees a provider-specific payload. Fixture-tested.
 */
import { sanitizeHtmlFragment } from '@/core/html/sanitize';
import type { EmailAddress, EmailMessage, InboxItem } from './types';

/** Collapse an HTML body to readable plain text (for AI prompts / fallback). */
function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse a raw "From" header ("Jane Doe <jane@x.com>" or "jane@x.com"). */
export function parseAddress(raw: string | undefined): EmailAddress {
  const v = (raw ?? '').trim();
  if (!v) return { email: '' };
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
  return { email: v };
}

// ── Gmail (REST users.messages, format=metadata/full) ──────────────────

export interface GmailHeader { name: string; value: string }
export interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[]; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string } }> };
}

function header(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function gmailReceivedAt(msg: GmailMessage): string {
  if (msg.internalDate) {
    const n = Number(msg.internalDate);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  const date = header(msg, 'date');
  const parsed = date ? Date.parse(date) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

export function normalizeGmail(msg: GmailMessage): InboxItem {
  return {
    id: msg.id,
    threadId: msg.threadId,
    provider: 'google',
    from: parseAddress(header(msg, 'from')),
    subject: header(msg, 'subject') ?? '(no subject)',
    snippet: msg.snippet ?? '',
    receivedAt: gmailReceivedAt(msg),
    unread: (msg.labelIds ?? []).includes('UNREAD'),
  };
}

export const normalizeGmailList = (messages: GmailMessage[]): InboxItem[] => messages.map(normalizeGmail);

/** Decode a Gmail base64url body part. */
function decodeGmailBody(msg: GmailMessage): string {
  const data =
    msg.payload?.body?.data ??
    msg.payload?.parts?.find((p) => p.mimeType === 'text/plain')?.body?.data ??
    msg.payload?.parts?.find((p) => p.body?.data)?.body?.data;
  if (!data) return msg.snippet ?? '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return msg.snippet ?? '';
  }
}

/** Decode the Gmail text/html part, if present, as a base64url string. */
function decodeGmailHtml(msg: GmailMessage): string | undefined {
  const data = msg.payload?.parts?.find((p) => p.mimeType === 'text/html')?.body?.data;
  if (!data) return undefined;
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

export function gmailToMessage(msg: GmailMessage): EmailMessage {
  const rawHtml = decodeGmailHtml(msg);
  // Presentational: keep sanitized inline style + table layout so the message
  // renders close to how the sender built it (not flattened to plain text).
  const html = rawHtml ? sanitizeHtmlFragment(rawHtml, { presentational: true }) : undefined;
  const plain = decodeGmailBody(msg).trim();
  return {
    ...normalizeGmail(msg),
    to: (header(msg, 'to') ?? '').split(',').map(parseAddress).filter((a) => a.email),
    // Prefer the decoded plain part; fall back to text from the HTML so AI
    // prompts and search always have something even for HTML-only mail.
    body: plain || (rawHtml ? htmlToText(rawHtml) : ''),
    html: html || undefined,
  };
}

// ── Microsoft 365 (Graph /me/messages) ─────────────────────────────────

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  body?: { content?: string; contentType?: string };
}

function graphAddress(a?: { name?: string; address?: string }): EmailAddress {
  return { name: a?.name || undefined, email: a?.address ?? '' };
}

/** Parse an ISO-ish date safely; returns '' rather than throwing on garbage. */
function safeIso(value: string | undefined): string {
  if (!value) return '';
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

export function normalizeM365(msg: GraphMessage): InboxItem {
  return {
    id: msg.id,
    threadId: msg.conversationId,
    provider: 'microsoft',
    from: graphAddress(msg.from?.emailAddress),
    subject: msg.subject ?? '(no subject)',
    snippet: msg.bodyPreview ?? '',
    receivedAt: safeIso(msg.receivedDateTime),
    unread: msg.isRead === false,
  };
}

export const normalizeM365List = (messages: GraphMessage[]): InboxItem[] => messages.map(normalizeM365);

export function m365ToMessage(msg: GraphMessage): EmailMessage {
  const raw = msg.body?.content ?? msg.bodyPreview ?? '';
  const isHtml = msg.body?.contentType === 'html';
  // Presentational: keep sanitized inline style + table layout (see gmail path).
  const html = isHtml ? sanitizeHtmlFragment(raw, { presentational: true }) : undefined;
  return {
    ...normalizeM365(msg),
    to: (msg.toRecipients ?? []).map((r) => graphAddress(r.emailAddress)).filter((a) => a.email),
    body: isHtml ? htmlToText(raw) : raw.trim(),
    html: html || undefined,
  };
}
