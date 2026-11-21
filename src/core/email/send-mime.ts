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

/** The base64url MIME message Gmail's send takes. `inReplyTo`/`references` thread it under the original. */
export function buildSendRaw(input: Recipients & { subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const lines = [`To: ${input.to.join(', ')}`];
  if (input.cc.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  if (input.bcc.length) lines.push(`Bcc: ${input.bcc.join(', ')}`);
  lines.push(`Subject: ${headerText(input.subject)}`);
  const inReplyTo = messageIds(input.inReplyTo);
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${[messageIds(input.references), inReplyTo].filter(Boolean).join(' ')}`);
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', input.body);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
