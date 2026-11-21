/**
 * Pure normalization of provider list/message responses into the
 * provider-agnostic InboxItem/EmailMessage shapes (feature #7). Keeping this
 * pure means gmail vs m365 differences are handled in one tested place and the
 * UI never sees a provider-specific payload. Fixture-tested.
 */
import { sanitizeHtmlFragment } from '@/core/html/sanitize';
import type { EmailAddress, EmailAttachment, EmailMessage, InboxItem } from './types';

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
  payload?: GmailPart & { headers?: GmailHeader[] };
}
/** One MIME part. Mail with attachments nests its body: multipart/mixed → multipart/alternative → text/plain + text/html. */
export interface GmailPart {
  mimeType?: string;
  /** Stable position of the part in the message ("0", "1.2"); the attachment id is not stable between reads. */
  partId?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
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

/**
 * Split an address-list header on the commas between addresses, not the ones
 * inside a quoted display name ("Doe, Jane" <jane@x.com>). Pure.
 */
export function parseAddressList(raw: string | undefined): EmailAddress[] {
  if (!raw) return [];
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) { out.push(current); current = ''; } else current += ch;
  }
  out.push(current);
  return out.map(parseAddress).filter((a) => a.email);
}

export function normalizeGmail(msg: GmailMessage): InboxItem {
  const to = parseAddressList(header(msg, 'to'));
  return {
    id: msg.id,
    threadId: msg.threadId,
    provider: 'google',
    from: parseAddress(header(msg, 'from')),
    ...(to.length ? { to } : {}),
    ...(msg.labelIds ? { starred: msg.labelIds.includes('STARRED') } : {}),
    subject: header(msg, 'subject') ?? '(no subject)',
    snippet: msg.snippet ?? '',
    receivedAt: gmailReceivedAt(msg),
    unread: (msg.labelIds ?? []).includes('UNREAD'),
  };
}

export const normalizeGmailList = (messages: GmailMessage[]): InboxItem[] => messages.map(normalizeGmail);

function decodeBase64Url(data: string | undefined): string | undefined {
  if (!data) return undefined;
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/** The first body part of a MIME type, at any depth; attachments (parts with a filename) are not bodies. */
function findBody(part: GmailPart | undefined, mimeType: string, depth = 0): string | undefined {
  if (!part || depth > 10) return undefined;
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** The plain-text body. A single-part message without a MIME type is taken as text. */
function decodeGmailBody(msg: GmailMessage): string | undefined {
  const untyped = !msg.payload?.mimeType && !msg.payload?.parts ? msg.payload?.body?.data : undefined;
  return decodeBase64Url(findBody(msg.payload, 'text/plain') ?? untyped);
}

/** The text/html body, if the message has one. */
function decodeGmailHtml(msg: GmailMessage): string | undefined {
  return decodeBase64Url(findBody(msg.payload, 'text/html'));
}

/** The part of a message at a `partId`, at any depth. Pure. */
export function findGmailPart(part: GmailPart | undefined, partId: string, depth = 0): GmailPart | undefined {
  if (!part || depth > 10) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findGmailPart(child, partId, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The files attached to a Gmail message, at any MIME depth. An image the HTML
 * body shows in place (inline disposition with a Content-ID) is not listed.
 * The id is the part's position, which stays the same across reads. Pure.
 */
export function gmailAttachments(msg: GmailMessage): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  const walk = (part: GmailPart | undefined, depth: number) => {
    if (!part || depth > 10) return;
    if (part.filename && part.partId !== undefined && (part.body?.attachmentId || part.body?.data)) {
      const h = (name: string) => part.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? '';
      const inline = /^\s*inline/i.test(h('content-disposition')) && !!h('content-id');
      if (!inline) out.push({ id: part.partId, name: part.filename, size: part.body?.size ?? 0, contentType: (part.mimeType || 'application/octet-stream').toLowerCase() });
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(msg.payload, 0);
  return out;
}

const cc = (list: EmailAddress[]) => (list.length ? { cc: list } : {});

export function gmailToMessage(msg: GmailMessage): EmailMessage {
  const rawHtml = decodeGmailHtml(msg);
  // Presentational: keep sanitized inline style + table layout so the message
  // renders close to how the sender built it (not flattened to plain text).
  const html = rawHtml ? sanitizeHtmlFragment(rawHtml, { presentational: true, blockRemoteImages: true }) : undefined;
  const plain = (decodeGmailBody(msg) ?? '').trim();
  const attachments = gmailAttachments(msg);
  return {
    ...normalizeGmail(msg),
    to: parseAddressList(header(msg, 'to')),
    ...cc(parseAddressList(header(msg, 'cc'))),
    hasAttachments: attachments.length > 0,
    ...(attachments.length ? { attachments } : {}),
    // Prefer the decoded plain part; fall back to text from the HTML so AI
    // prompts and search always have something even for HTML-only mail.
    body: plain || (rawHtml ? htmlToText(rawHtml) : (msg.snippet ?? '')),
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
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
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

const graphList = (list: GraphMessage['toRecipients']) => (list ?? []).map((r) => graphAddress(r.emailAddress)).filter((a) => a.email);

export function normalizeM365(msg: GraphMessage): InboxItem {
  const to = graphList(msg.toRecipients);
  return {
    id: msg.id,
    threadId: msg.conversationId,
    provider: 'microsoft',
    from: graphAddress(msg.from?.emailAddress),
    subject: msg.subject ?? '(no subject)',
    snippet: msg.bodyPreview ?? '',
    receivedAt: safeIso(msg.receivedDateTime),
    unread: msg.isRead === false,
    ...(to.length ? { to } : {}),
    ...(msg.flag ? { starred: msg.flag.flagStatus === 'flagged' } : {}),
    ...(typeof msg.hasAttachments === 'boolean' ? { hasAttachments: msg.hasAttachments } : {}),
  };
}

export const normalizeM365List = (messages: GraphMessage[]): InboxItem[] => messages.map(normalizeM365);

export function m365ToMessage(msg: GraphMessage): EmailMessage {
  const raw = msg.body?.content ?? msg.bodyPreview ?? '';
  const isHtml = msg.body?.contentType === 'html';
  // Presentational: keep sanitized inline style + table layout (see gmail path).
  const html = isHtml ? sanitizeHtmlFragment(raw, { presentational: true, blockRemoteImages: true }) : undefined;
  return {
    ...normalizeM365(msg),
    to: graphList(msg.toRecipients),
    ...cc(graphList(msg.ccRecipients)),
    body: isHtml ? htmlToText(raw) : raw.trim(),
    html: html || undefined,
  };
}
