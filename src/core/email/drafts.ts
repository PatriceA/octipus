/**
 * Reply drafts saved IN the mailbox — Gmail's Drafts, Outlook's Drafts folder
 * — threaded under the message they answer, for the owner to read, edit and
 * send themselves. Nothing here sends mail: this is the middle step an
 * unattended agent can take (its sends are refused) and that a person can
 * finish from any mail client.
 */
import { coreLogger } from '@/utils/logger';
import { type GmailMessage, parseAddress } from './normalize';
import { gmailApi, graphApi } from './providers';
import type { EmailProvider } from './types';

const BODY_MAX = 20_000;

/** Strip CR/LF so a crafted header value can't inject extra MIME headers. */
function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim();
}

/** "Re: <subject>", without stacking a second "Re:". Pure. */
export function replySubject(subject: string): string {
  const s = headerValue(subject) || '(no subject)';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The MIME of a threaded Gmail reply draft, base64url-encoded: `In-Reply-To`
 * and `References` name the original so every client threads it. Pure.
 */
export function buildGmailReplyRaw(input: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [`To: ${headerValue(input.to)}`, `Subject: ${replySubject(input.subject)}`];
  if (input.inReplyTo) {
    lines.push(`In-Reply-To: ${headerValue(input.inReplyTo)}`);
    lines.push(`References: ${headerValue([input.references, input.inReplyTo].filter(Boolean).join(' '))}`);
  }
  lines.push('Content-Type: text/plain; charset=utf-8', '', input.body);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function header(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export interface SavedDraft {
  draftId: string;
  provider: EmailProvider;
  /** Who the draft is addressed to. */
  to: string;
  subject: string;
}

/**
 * Save a reply to `messageId` as a draft in the owner's mailbox. `body` is
 * the reply text only; the provider quotes the original where it does so
 * (Outlook), Gmail threads it. Never sends.
 */
export async function saveReplyDraft(userId: string, provider: EmailProvider, messageId: string, body: string): Promise<SavedDraft> {
  const text = body.trim().slice(0, BODY_MAX);
  if (!text) throw new Error('A reply draft needs a body');
  if (provider === 'google') {
    const original = (await gmailApi(
      userId,
      'GET',
      `/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
    )) as GmailMessage;
    const to = parseAddress(header(original, 'reply-to') ?? header(original, 'from')).email;
    if (!to) throw new Error('The original message has no sender to reply to');
    const subject = header(original, 'subject') ?? '';
    const raw = buildGmailReplyRaw({ to, subject, body: text, inReplyTo: header(original, 'message-id'), references: header(original, 'references') });
    const draft = (await gmailApi(userId, 'POST', '/drafts', { message: { raw, threadId: original.threadId } })) as { id?: string };
    coreLogger.info({ userId, provider }, 'email: reply draft saved'); // no address, subject or body logged
    return { draftId: draft.id ?? '', provider, to, subject: replySubject(subject) };
  }
  const draft = (await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(messageId)}/createReply`, { comment: text })) as {
    id?: string;
    subject?: string;
    toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  };
  coreLogger.info({ userId, provider }, 'email: reply draft saved');
  return {
    draftId: draft.id ?? '',
    provider,
    to: draft.toRecipients?.[0]?.emailAddress?.address ?? '',
    subject: draft.subject ?? '',
  };
}
