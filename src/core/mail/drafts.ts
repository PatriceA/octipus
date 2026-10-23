/**
 * Composing drafts (docs/MAIL.md#drafts): recipients parsed and checked, and
 * a reply's recipients, subject, threading headers and quote taken from the
 * message it answers. Pure.
 */
import type { MailDraftWrite } from '@/db/repositories/mail';
import type { MailAccount, MailMessage } from '@/db/schema/mail';
import type { MailAddress } from '@/shared/mail';

export class MailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailInputError';
  }
}

/** A plain address: one @, no spaces, no angle brackets or line breaks. */
const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const BODY_MAX = 100_000;
const QUOTE_MAX = 4_000;

export function isMailAddress(value: string): boolean {
  return value.length <= 320 && ADDRESS_RE.test(value);
}

/**
 * Recipients from what a person or agent typed: "a@x.de, Jane <j@y.de>", a
 * list of those, or address objects. Throws `MailInputError` naming the
 * first one that is not an address.
 */
export function parseRecipients(input: unknown): MailAddress[] {
  const items: unknown[] = typeof input === 'string' ? input.split(/[,;\n]/) : Array.isArray(input) ? input : input == null ? [] : [input];
  const out: MailAddress[] = [];
  for (const item of items) {
    let name: string | undefined;
    let address: string;
    if (typeof item === 'string') {
      const v = item.trim();
      if (!v) continue;
      const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      name = m?.[1]?.trim() || undefined;
      address = (m ? m[2] : v).trim();
    } else if (item && typeof item === 'object' && typeof (item as MailAddress).address === 'string') {
      address = (item as MailAddress).address.trim();
      const n = (item as MailAddress).name;
      name = typeof n === 'string' && n.trim() ? n.trim() : undefined;
    } else {
      throw new MailInputError('A recipient is not an email address');
    }
    if (!isMailAddress(address)) throw new MailInputError(`Not an email address: ${address.slice(0, 100)}`);
    const clean = name?.replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 200);
    if (!out.some((a) => a.address.toLowerCase() === address.toLowerCase())) out.push(clean ? { name: clean, address } : { address });
  }
  return out;
}

/** A subject on one line, capped. */
export function cleanSubject(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) : '';
}

/** A body, capped; a draft may be empty while it is written. */
export function cleanBody(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').slice(0, BODY_MAX) : '';
}

/** "Re: <subject>", without stacking a second one. */
export function replySubject(subject: string): string {
  const s = subject.trim() || '(no subject)';
  return /^(re|aw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

function quote(original: Pick<MailMessage, 'bodyText' | 'fromAddress' | 'date'>): string {
  const who = original.fromAddress ? (original.fromAddress.name ? `${original.fromAddress.name} <${original.fromAddress.address}>` : original.fromAddress.address) : 'The sender';
  const text = original.bodyText.length > QUOTE_MAX ? `${original.bodyText.slice(0, QUOTE_MAX)}\n[…]` : original.bodyText;
  return `${original.date.toISOString().slice(0, 16).replace('T', ' ')} UTC, ${who}:\n${text.split('\n').map((l) => `> ${l}`).join('\n')}`;
}

/**
 * A reply to `original` (a received message) from `account`: to its
 * Reply-To or sender; with `all`, the other recipients in cc (the account's
 * own address left out). Threaded by In-Reply-To and References, the
 * original quoted below `body`.
 */
export function replyDraft(account: Pick<MailAccount, 'address'>, original: MailMessage, body: string, all = false): MailDraftWrite {
  const own = account.address.toLowerCase();
  const to = (original.replyTo.length > 0 ? original.replyTo : original.fromAddress ? [original.fromAddress] : [])
    .filter((a) => a.address.toLowerCase() !== own);
  if (to.length === 0) throw new MailInputError('The message has no sender to reply to');
  const cc = all
    ? [...original.toAddresses, ...original.ccAddresses].filter((a) => {
      const addr = a.address.toLowerCase();
      return addr !== own && !to.some((t) => t.address.toLowerCase() === addr);
    })
    : [];
  const references = [original.references, original.messageIdHeader].filter(Boolean).join(' ').slice(-4000) || null;
  return {
    toAddresses: to,
    ccAddresses: cc.filter((a, i) => cc.findIndex((b) => b.address.toLowerCase() === a.address.toLowerCase()) === i).slice(0, 49),
    subject: replySubject(original.subject),
    bodyText: `${cleanBody(body).trimEnd()}\n\n${quote(original)}`.slice(0, BODY_MAX),
    inReplyTo: original.messageIdHeader,
    references,
  };
}
