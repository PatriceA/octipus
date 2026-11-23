/**
 * What of a mail reaches the turn (docs/CHANNELS.md#email): the new text the
 * sender wrote, a forwarded mail below it, and the reply's subject and
 * threading headers. Attachments are only named: a mail's files never reach
 * the turn, the document pipeline or the knowledge index, where content a
 * mail planted would later be read by full-privilege turns.
 *
 * The text/plain part is preferred; HTML-only mail is turned into text by the
 * mail stack's own converter (scripts and styles dropped, no markup kept).
 * Quoted reply history and a signature are cut conservatively (`splitMail`);
 * a forwarded mail is kept, fenced as untrusted text below the sender's own.
 */
import { simpleParser } from 'mailparser';
import { htmlToText } from '@/core/mail/parse';
import { wrapUntrusted } from '@/security/untrusted-envelope';
import { messageIds } from './headers';

/** Longest text passed to a turn; the rest is cut with a note. */
export const MAX_TEXT_CHARS = 20_000;
/** Most attachment names listed in the answer's note. */
const MAX_NAMED = 10;
/** Most Message-IDs kept in a reply's `References`, and read from a mail's. */
export const MAX_REFERENCES = 20;

/** A line that starts quoted reply history (English, German, French, Dutch, Spanish clients). */
const REPLY_HEADER = [
  /^On\b.{0,300}\bwrote:\s*$/i,
  /^Am\b.{0,300}\bschrieb\b.{0,200}:\s*$/i,
  /^Le\b.{0,300}\ba écrit\s*:\s*$/i,
  /^Op\b.{0,300}\bschreef\b.{0,200}:\s*$/i,
  /^El\b.{0,300}\bescribió:\s*$/i,
];

/** A line that starts a forwarded mail, whatever the subject says. */
const FORWARD_MARKER = [
  /^-{2,}\s*(Forwarded message|Weitergeleitete Nachricht|Message transféré|Doorgestuurd bericht)\s*-{2,}\s*$/i,
  /^Begin forwarded message:\s*$/i,
];

/** Outlook writes replies and forwards alike: these start either, told apart by the subject. */
const OUTLOOK_SEPARATOR = [
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}\s*$/i,
  /^_{20,}\s*$/,
];

/** Lines that end a phone or webmail client's footer. */
const CLIENT_FOOTER = /^(Sent from my \w+|Get Outlook for \w+|Von meinem \w+ gesendet)\b/i;

/** A subject that says the mail is a forward. */
export const FORWARD_SUBJECT = /^(fwd?|wg|tr)\s*:/i;

/** An Outlook header block: From:, then Sent:/Date: and Subject: within the next lines. */
function isOutlookHeaderAt(lines: readonly string[], i: number): boolean {
  if (!/^From:\s/i.test(lines[i].trim())) return false;
  const next = lines.slice(i + 1, i + 5).map((l) => l.trim());
  return next.some((l) => /^(Sent|Date|Gesendet):\s/i.test(l)) && next.some((l) => /^(Subject|Betreff):\s/i.test(l));
}

/** The sender's own text: the signature and a phone footer cut off. */
function ownText(lines: readonly string[]): string {
  let kept = [...lines];
  const sig = kept.findIndex((l) => l === '-- ' || l === '--');
  if (sig >= 0) kept = kept.slice(0, sig);
  while (kept.length > 0 && (!kept[kept.length - 1].trim() || CLIENT_FOOTER.test(kept[kept.length - 1].trim()))) kept.pop();
  return kept.join('\n').trim();
}

export interface SplitMail {
  /** What the sender wrote. */
  own: string;
  /** A forwarded mail below it, kept whole; '' when there is none. */
  forwarded: string;
}

/**
 * The sender's text and a forwarded mail, conservatively. Reply history is
 * cut: from a reply header ("On … wrote:"), an Outlook separator or header
 * block in a reply, or a trailing block of `>` lines. A forward is kept: the
 * text from a forward marker (or, in a mail whose subject says it is a
 * forward, from Outlook's separator) is returned apart, whole — it is what
 * the request is about. When cutting would leave nothing, the text is kept.
 * Pure.
 */
export function splitMail(text: string, opts: { forward?: boolean } = {}): SplitMail {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const outlook = OUTLOOK_SEPARATOR.some((re) => re.test(line)) || isOutlookHeaderAt(lines, i);
    if (FORWARD_MARKER.some((re) => re.test(line)) || (opts.forward && outlook)) {
      return { own: ownText(lines.slice(0, i)), forwarded: lines.slice(i).join('\n').trim() };
    }
    // "On Mon, 3 Mar 2026 at 10:00, Ann <ann@x>" wraps over two lines in many clients.
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    if (outlook || REPLY_HEADER.some((re) => re.test(line)) || (/^On\b/i.test(line) && /\bwrote:\s*$/i.test(joined))) {
      return { own: ownText(lines.slice(0, i)) || text.trim(), forwarded: '' };
    }
  }
  const kept = [...lines];
  // A trailing block of quoted lines (bottom quoting without a header).
  while (kept.length > 0 && (/^\s*>/.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  return { own: ownText(kept) || text.trim(), forwarded: '' };
}

/** `splitMail` as one text. Pure. */
export function stripQuoted(text: string, opts: { forward?: boolean } = {}): string {
  const { own, forwarded } = splitMail(text, opts);
  return forwarded ? `${own}\n\n${forwarded}`.trim() : own;
}

export interface MailContent {
  text: string;
  /** The names of the mail's attached files (not read), at most `MAX_NAMED`. */
  attachmentNames: string[];
  /** How many files the mail had. */
  attachmentCount: number;
}

/** The new text and the attached files' names of a raw mail. Never throws on malformed mail: what cannot be read stays empty. */
export async function mailContent(raw: Buffer): Promise<MailContent> {
  let mail: Awaited<ReturnType<typeof simpleParser>>;
  try {
    mail = await simpleParser(raw, { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  } catch {
    return { text: '', attachmentNames: [], attachmentCount: 0 };
  }
  const plain = mail.text?.trim() ? mail.text : htmlToText(typeof mail.html === 'string' ? mail.html : '');
  const { own, forwarded } = splitMail(plain, { forward: FORWARD_SUBJECT.test((mail.subject ?? '').trim()) });
  // A forwarded mail is someone else's text: fenced as untrusted, below what the sender wrote.
  let text = forwarded ? `${own}\n\n${wrapUntrusted('forwarded mail', forwarded)}`.trim() : own;
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[The rest of this mail was cut: it is longer than ${MAX_TEXT_CHARS} characters.]`;
  const files = mail.attachments.filter((a) => !a.related);
  return {
    text,
    attachmentNames: files.slice(0, MAX_NAMED).map((a) => (a.filename ?? 'attachment').replace(/[\r\n]+/g, ' ').slice(0, 100)),
    attachmentCount: files.length,
  };
}

/** The reply's subject: `Re: ` once, whatever the client wrote before. Pure. */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!s) return 'Re: your message';
  return /^(re|aw|sv|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** The reply's `References`: the answered mail's chain plus its own id, the newest kept. Pure. */
export function replyReferences(references: string | null | undefined, messageId: string): string {
  const chain = messageIds(references).filter((id) => id !== messageId);
  return [...chain, messageId].slice(-MAX_REFERENCES).join(' ');
}
