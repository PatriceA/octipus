/**
 * The recipients and the MIME of a mail sent from the Email page. Pure.
 *
 * Everything here guards one boundary: text a person (or a model's draft)
 * supplied becomes mail headers. An address is accepted only in a plain
 * shape, so nothing in it can start another header.
 */

/** As many recipients as the IMAP path allows (core/mail/drafts.ts). */
export const MAX_RECIPIENTS = 50;

export class EmailInputError extends Error {}

const ADDRESS = /^[^\s@<>,;:"'()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

/**
 * "a@x.de, Jane <j@y.de>; k@z.de" → plain addresses, in order, once each.
 * Display names are dropped: the provider shows its own. Throws
 * EmailInputError on anything that is not an address.
 */
export function parseRecipientList(raw: string | undefined, field: string): string[] {
  if (!raw) return [];
  if (/[\r\n]/.test(raw)) throw new EmailInputError(`${field}: line breaks are not allowed in addresses`);
  const out: string[] = [];
  // Split on the separators between addresses, not a comma inside a quoted name.
  for (const piece of raw.match(/(?:"[^"]*"|[^,;])+/g) ?? []) {
    const v = piece.trim();
    if (!v) continue;
    const m = v.match(/^"?[^"<]*"?\s*<([^<>]+)>$/);
    const address = (m ? m[1] : v).trim();
    if (address.length > 320 || !ADDRESS.test(address)) throw new EmailInputError(`${field}: "${address.slice(0, 60)}" is not an email address`);
    if (!out.some((a) => a.toLowerCase() === address.toLowerCase())) out.push(address);
  }
  return out;
}

export interface Recipients { to: string[]; cc: string[]; bcc: string[] }

/** The three recipient lists of a send, validated together. */
export function parseRecipients(input: { to: string; cc?: string; bcc?: string }): Recipients {
  const to = parseRecipientList(input.to, 'To');
  const cc = parseRecipientList(input.cc, 'Cc');
  const bcc = parseRecipientList(input.bcc, 'Bcc');
  if (to.length === 0) throw new EmailInputError('Add at least one recipient.');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new EmailInputError(`At most ${MAX_RECIPIENTS} recipients per message.`);
  return { to, cc, bcc };
}

/** One header line's value: no line breaks, and RFC 2047 encoded when it is not plain ASCII. */
export function headerText(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  if ([...flat].every((ch) => ch >= ' ' && ch <= '~')) return flat;
  // One encoded word holds at most 75 characters: 45 bytes of UTF-8 per word, cut between code points.
  const words: string[] = [];
  let chunk = '';
  for (const ch of flat) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Message ids as a header carries them: "<id>" tokens only, so a stored header cannot smuggle a line. */
function messageIds(value: string | undefined): string {
  return (value ?? '').match(/<[^<>\s]+>/g)?.join(' ') ?? '';
}

/** "Re: <subject>", without stacking a second "Re:". */
export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, ' ').trim() || '(no subject)';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** A file that goes out with a mail. */
export interface OutgoingFile {
  name: string;
  contentType: string;
  content: Uint8Array;
}

/** At most this much attached to one mail, all files together (what Gmail and Outlook accept). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** At most this many files on one mail. */
export const MAX_ATTACHMENTS = 20;

/**
 * A file name safe to put in a header and to save on the recipient's disk:
 * no path, no control or quote characters, at most 120 characters. Pure.
 */
export function safeFileName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = [...base]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && !'"<>:|?*;'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!clean) return 'attachment';
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
  return clean.slice(0, 120 - ext.length) + ext;
}

/** A content type as `type/subtype`, or the generic one: nothing else reaches the header. Pure. */
export function safeContentType(raw: string | undefined): string {
  const type = (raw ?? '').toLowerCase().split(';')[0].trim();
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(type) ? type : 'application/octet-stream';
}

/** Check the files of one mail against the limits; throws EmailInputError. */
export function checkAttachments(files: Array<{ content: Uint8Array }>): void {
  if (files.length > MAX_ATTACHMENTS) throw new EmailInputError(`At most ${MAX_ATTACHMENTS} attachments per message.`);
  const total = files.reduce((sum, f) => sum + f.content.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) throw new EmailInputError(`Attachments may add up to ${MAX_ATTACHMENT_BYTES / 1048576} MB per message.`);
}

/** Base64 in lines of 76 characters, as MIME bodies are written. */
function base64Lines(content: Uint8Array | string): string {
  const b64 = (typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)).toString('base64');
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

/** A MIME parameter: quoted ASCII, plus the RFC 2231 form when the name is not plain ASCII. */
function fileNameParam(param: 'name' | 'filename', name: string): string {
  const ascii = [...name].every((ch) => ch >= ' ' && ch <= '~');
  const fallback = [...name].map((ch) => (ch >= ' ' && ch <= '~' && ch !== '"' && ch !== '\\' ? ch : '_')).join('');
  return ascii ? `${param}="${fallback}"` : `${param}="${fallback}"; ${param}*=UTF-8''${encodeURIComponent(name)}`;
}

let boundaryCount = 0;
/** A boundary that cannot occur in base64 or in the encoded parts it separates ("=_" never appears in base64 lines). */
function boundary(): string {
  boundaryCount = (boundaryCount + 1) % 1_000_000;
  return `=_octipus_${Date.now().toString(36)}_${boundaryCount}_${Math.random().toString(36).slice(2, 12)}`;
}

/** The body: plain text alone, or plain text and HTML as alternatives. Base64, so no line of it can look like a boundary. */
function bodyPart(text: string, html: string | undefined): string[] {
  const plain = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(text)];
  if (!html) return plain;
  const b = boundary();
  return [
    `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, ...plain,
    `--${b}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(html),
    `--${b}--`,
  ];
}

export type SendMimeInput = Recipients & { subject: string; body: string; html?: string; attachments?: OutgoingFile[]; inReplyTo?: string; references?: string };

/** The base64url MIME message Gmail's JSON send takes. */
export function buildSendRaw(input: SendMimeInput): string {
  return Buffer.from(buildSendMime(input), 'utf8').toString('base64url');
}

/**
 * The MIME message of a mail. `inReplyTo`/`references` thread it under the
 * original. With `html` the mail carries text and HTML as alternatives; with
 * `attachments` it is multipart/mixed. The caller passes HTML it built from a
 * whitelist (core/email/compose-format.ts), never HTML a browser handed over.
 */
export function buildSendMime(input: SendMimeInput): string {
  const lines = [`To: ${input.to.join(', ')}`];
  if (input.cc.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  if (input.bcc.length) lines.push(`Bcc: ${input.bcc.join(', ')}`);
  lines.push(`Subject: ${headerText(input.subject)}`);
  const inReplyTo = messageIds(input.inReplyTo);
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${[messageIds(input.references), inReplyTo].filter(Boolean).join(' ')}`);
  }
  lines.push('MIME-Version: 1.0');
  const files = input.attachments ?? [];
  if (!input.html && files.length === 0) {
    // A plain mail keeps the shape it always had.
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', input.body);
    return lines.join('\r\n');
  }
  if (files.length === 0) {
    lines.push(...bodyPart(input.body, input.html));
    return lines.join('\r\n');
  }
  checkAttachments(files);
  const b = boundary();
  lines.push(`Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, ...bodyPart(input.body, input.html));
  for (const file of files) {
    const name = safeFileName(file.name);
    lines.push(
      `--${b}`,
      `Content-Type: ${safeContentType(file.contentType)}; ${fileNameParam('name', name)}`,
      `Content-Disposition: attachment; ${fileNameParam('filename', name)}`,
      'Content-Transfer-Encoding: base64', '',
      base64Lines(file.content),
    );
  }
  lines.push(`--${b}--`, '');
  return lines.join('\r\n');
}
