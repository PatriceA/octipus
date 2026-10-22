/**
 * A raw message (RFC 822) turned into what `mail_messages` stores: the
 * addresses, a plain-text body (always), a sanitized HTML body (when there
 * was one), a snippet, and the attachments' names and sizes. The raw source
 * itself is kept apart (`mail_raw`) so attachments can be downloaded later.
 *
 * Mail is untrusted: HTML goes through the same sanitizer as the Gmail and
 * Outlook inbox, and no header or body is logged.
 */
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser';
import { sanitizeHtmlFragment } from '@/core/html/sanitize';
import type { StoredAttachment } from '@/db/schema/mail';
import type { MailAddress } from '@/shared/mail';

/** Longest plain-text body stored; the raw message keeps the rest. */
export const BODY_TEXT_MAX = 200_000;
const BODY_HTML_MAX = 500_000;
const SNIPPET_MAX = 200;
const SUBJECT_MAX = 500;
const ADDRESSES_MAX = 100;

export interface ParsedMessage {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: MailAddress | null;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  date: Date | null;
  text: string;
  html: string | null;
  snippet: string;
  attachments: StoredAttachment[];
}

/** Flatten mailparser's address objects (groups included) to plain addresses. */
export function addressesOf(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const out: MailAddress[] = [];
  const visit = (entries: AddressObject['value']) => {
    for (const e of entries) {
      if (e.group) visit(e.group);
      else if (e.address) out.push(e.name ? { name: e.name.slice(0, 200), address: e.address.slice(0, 320) } : { address: e.address.slice(0, 320) });
    }
  };
  for (const obj of Array.isArray(value) ? value : value ? [value] : []) visit(obj.value);
  return out.slice(0, ADDRESSES_MAX);
}

/** HTML to readable text, for a message that has no plain-text part. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** One line of preview: whitespace collapsed, capped. */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat;
}

function referencesOf(value: ParsedMail['references']): string | null {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const joined = list.join(' ').trim();
  return joined ? joined.slice(0, 4000) : null;
}

function clean(value: string | undefined, max: number): string | null {
  const v = value?.replace(/[\r\n]+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}

/** Parse a raw message. Never throws on malformed mail: what cannot be read stays empty. */
export async function parseRawMessage(raw: Buffer): Promise<ParsedMessage> {
  let mail: ParsedMail;
  try {
    mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  } catch {
    return {
      messageIdHeader: null, inReplyTo: null, references: null, from: null, replyTo: [], to: [], cc: [],
      subject: '(unreadable message)', date: null, text: '', html: null, snippet: '', attachments: [],
    };
  }
  const rawHtml = typeof mail.html === 'string' ? mail.html : '';
  const html = rawHtml ? sanitizeHtmlFragment(rawHtml.slice(0, BODY_HTML_MAX * 2), { presentational: true }).slice(0, BODY_HTML_MAX) : null;
  const text = (mail.text?.trim() ? mail.text : htmlToText(rawHtml)).slice(0, BODY_TEXT_MAX);
  return {
    messageIdHeader: clean(mail.messageId, 998),
    inReplyTo: clean(mail.inReplyTo, 998),
    references: referencesOf(mail.references),
    from: addressesOf(mail.from)[0] ?? null,
    replyTo: addressesOf(mail.replyTo),
    to: addressesOf(mail.to),
    cc: addressesOf(mail.cc),
    subject: clean(mail.subject, SUBJECT_MAX) ?? '',
    date: mail.date && Number.isFinite(mail.date.getTime()) ? mail.date : null,
    text,
    html: html || null,
    snippet: snippetOf(text),
    attachments: mail.attachments
      .filter((a) => !a.related)
      .map((a) => ({ filename: (a.filename ?? 'attachment').slice(0, 255), contentType: a.contentType, size: a.size })),
  };
}

/** The attachments of a raw message, in the same order `parseRawMessage` lists them. */
export async function attachmentsOf(raw: Buffer): Promise<Array<StoredAttachment & { content: Buffer }>> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, skipHtmlToText: true });
  return mail.attachments
    .filter((a) => !a.related)
    .map((a) => ({ filename: (a.filename ?? 'attachment').slice(0, 255), contentType: a.contentType, size: a.size, content: a.content }));
}
