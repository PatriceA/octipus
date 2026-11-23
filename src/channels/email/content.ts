/**
 * What of a mail reaches the turn (docs/CHANNELS.md#email): the new text the
 * sender wrote, the attachments within limits, and the reply's subject and
 * threading headers.
 *
 * The text/plain part is preferred; HTML-only mail is turned into text by the
 * mail stack's own converter (scripts and styles dropped, no markup kept).
 * Quoted history and a signature are cut conservatively: only at a reply
 * header ("On … wrote:", "-----Original Message-----", an Outlook header
 * block), a trailing block of `>` lines, or the `-- ` signature delimiter.
 * When cutting would leave nothing, the text is kept whole.
 */
import { simpleParser } from 'mailparser';
import { htmlToText } from '@/core/mail/parse';
import type { Attachment } from '@/core/types';
import { messageIds } from './headers';

/** Longest text passed to a turn; the rest is cut with a note. */
export const MAX_TEXT_CHARS = 20_000;
/** Most attachments passed on from one mail; the rest are named in a note. */
export const MAX_ATTACHMENTS = 10;
/** Most Message-IDs kept in a reply's `References`. */
const MAX_REFERENCES = 20;

/** A line that starts quoted history in a reply (English, German, French, Dutch, Spanish clients). */
const REPLY_HEADER = [
  /^On\b.{0,300}\bwrote:\s*$/i,
  /^Am\b.{0,300}\bschrieb\b.{0,200}:\s*$/i,
  /^Le\b.{0,300}\ba écrit\s*:\s*$/i,
  /^Op\b.{0,300}\bschreef\b.{0,200}:\s*$/i,
  /^El\b.{0,300}\bescribió:\s*$/i,
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine|Forwarded message)\s*-{2,}\s*$/i,
  /^_{20,}\s*$/,
];

/** Lines that end a phone or webmail client's footer. */
const CLIENT_FOOTER = /^(Sent from my \w+|Get Outlook for \w+|Von meinem \w+ gesendet)\b/i;

/** The new text of a reply: quoted history and the signature cut off, conservatively. Pure. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // "On Mon, 3 Mar 2026 at 10:00, Ann <ann@x>" wraps over two lines in many clients.
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    if (REPLY_HEADER.some((re) => re.test(line)) || (/^On\b/i.test(line) && /\bwrote:\s*$/i.test(joined))) {
      end = i;
      break;
    }
    // An Outlook header block: From:, then Sent:/Date: and Subject: within the next lines.
    if (/^From:\s/i.test(line)) {
      const next = lines.slice(i + 1, i + 5).map((l) => l.trim());
      if (next.some((l) => /^(Sent|Date|Gesendet):\s/i.test(l)) && next.some((l) => /^(Subject|Betreff):\s/i.test(l))) {
        end = i;
        break;
      }
    }
  }
  let kept = lines.slice(0, end);
  // A trailing block of quoted lines (bottom quoting without a header).
  while (kept.length > 0 && (/^\s*>/.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  const sig = kept.findIndex((l) => l === '-- ' || l === '--');
  if (sig >= 0) kept = kept.slice(0, sig);
  while (kept.length > 0 && (!kept[kept.length - 1].trim() || CLIENT_FOOTER.test(kept[kept.length - 1].trim()))) kept.pop();
  const out = kept.join('\n').trim();
  return out || text.trim();
}

export interface MailContent {
  text: string;
  attachments: Attachment[];
  /** Attachments left out (over the count limit), by name. */
  omitted: string[];
}

function attachmentType(mime: string): Attachment['type'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

/** The new text and the attachments of a raw mail. Never throws on malformed mail: what cannot be read stays empty. */
export async function mailContent(raw: Buffer): Promise<MailContent> {
  let mail: Awaited<ReturnType<typeof simpleParser>>;
  try {
    mail = await simpleParser(raw, { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  } catch {
    return { text: '', attachments: [], omitted: [] };
  }
  const plain = mail.text?.trim() ? mail.text : htmlToText(typeof mail.html === 'string' ? mail.html : '');
  let text = stripQuoted(plain);
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[The rest of this mail was cut: it is longer than ${MAX_TEXT_CHARS} characters.]`;
  const files = mail.attachments.filter((a) => !a.related && a.content?.length);
  const attachments = files.slice(0, MAX_ATTACHMENTS).map((a): Attachment => ({
    type: attachmentType(a.contentType),
    mimeType: a.contentType,
    data: a.content,
    filename: (a.filename ?? 'attachment').slice(0, 255),
    size: a.size,
  }));
  return { text, attachments, omitted: files.slice(MAX_ATTACHMENTS).map((a) => a.filename ?? 'attachment') };
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
