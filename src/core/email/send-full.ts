/**
 * Sending a mail that carries HTML or attachments (the plain path stays in
 * service.ts sendReply, unchanged).
 *
 * Gmail: the MIME message from send-mime.ts. Up to a few MB it goes as JSON
 * (`raw`); larger, through Gmail's upload endpoint, which takes up to 35 MB.
 *
 * Microsoft 365: a draft first (a reply draft for a reply, so Outlook threads
 * and quotes it), its body and recipients set, each file attached (one
 * request for a small file, an upload session for a file over 3 MB, Graph's
 * limit for the simple form), then the draft is sent. A draft left behind by
 * a failure is removed again.
 */
import { getOAuthManager } from '@/security/oauth';
import { coreLogger } from '@/utils/logger';
import type { GmailMessage } from './normalize';
import { gmailApi, graphApi } from './providers';
import { buildSendMime, type OutgoingFile, type Recipients, replySubject } from './send-mime';
import type { EmailProvider } from './types';

export interface FullSend {
  recipients: Recipients;
  subject: string;
  /** The plain-text body (always sent). */
  text: string;
  /** The HTML body, built by compose-format.ts. Without it the HTML part is made from the text. */
  html?: string;
  attachments: OutgoingFile[];
  replyTo?: string;
}

/** Above this the Gmail JSON send is not used (its request limit is far below the 35 MB of the upload endpoint). */
export const GMAIL_JSON_MAX_BYTES = 4 * 1024 * 1024;
/** Graph takes a file in one request up to 3 MB; above, an upload session. */
export const GRAPH_SIMPLE_MAX_BYTES = 3 * 1024 * 1024;
/** Upload session chunks must be a multiple of 320 KiB. */
export const GRAPH_CHUNK_BYTES = 12 * 320 * 1024;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text as HTML, for a provider that needs an HTML body. */
export const textAsHtml = (text: string) => `<div>${text.split(/\r?\n/).map(escape).join('<br>')}</div>`;

async function token(userId: string, provider: EmailProvider): Promise<string> {
  const value = await getOAuthManager().getValidToken(userId, provider);
  if (!value) throw new Error(`${provider === 'google' ? 'Google' : 'Microsoft 365'} is not connected. Connect your account in Settings > Integrations.`);
  return value;
}

/** A failed provider answer, without its detail (which can echo the mail). */
async function refused(res: Response, what: string): Promise<never> {
  const detail = await res.text().catch(() => '');
  coreLogger.warn({ status: res.status, detail: detail.slice(0, 300) }, `email: ${what} failed`);
  throw new Error(`Mail provider returned an error (HTTP ${res.status}).`);
}

// ── Gmail ──────────────────────────────────────────────────────────────

async function sendGmail(userId: string, mail: FullSend): Promise<void> {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (mail.replyTo) {
    const original = (await gmailApi(userId, 'GET', `/messages/${encodeURIComponent(mail.replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`)) as GmailMessage;
    const header = (name: string) => original.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
    threadId = original.threadId;
    inReplyTo = header('message-id');
    references = header('references');
  }
  const mime = buildSendMime({
    ...mail.recipients, subject: mail.replyTo ? replySubject(mail.subject) : mail.subject, body: mail.text, html: mail.html, attachments: mail.attachments, inReplyTo, references,
  });
  const bytes = Buffer.byteLength(mime, 'utf8');
  if (bytes <= GMAIL_JSON_MAX_BYTES) {
    await gmailApi(userId, 'POST', '/messages/send', { raw: Buffer.from(mime, 'utf8').toString('base64url'), ...(threadId ? { threadId } : {}) });
    return;
  }
  // multipart/related: the metadata (the thread) first, the message itself second.
  const b = `octipus_upload_${Date.now().toString(36)}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`, 'utf8'),
    Buffer.from(mime, 'utf8'),
    Buffer.from(`\r\n--${b}--`, 'utf8'),
  ]);
  const res = await fetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token(userId, 'google')}`, 'Content-Type': `multipart/related; boundary=${b}` },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) await refused(res, 'Gmail upload send');
}

// ── Microsoft 365 ──────────────────────────────────────────────────────

const graphList = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

/**
 * Where Graph may send the bytes of an upload session: Microsoft's own hosts,
 * over https. The URL comes from Graph's answer, but nothing outside these
 * hosts ever receives a mail's attachment.
 */
export function isGraphUploadUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /(^|\.)(office\.com|office365\.com|outlook\.com|microsoft\.com|microsoftonline\.com|graph\.microsoft\.com)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/** The byte ranges of an upload session, in the order they are sent. Pure. */
export function uploadRanges(size: number, chunk = GRAPH_CHUNK_BYTES): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < size; start += chunk) out.push({ start, end: Math.min(size, start + chunk) - 1 });
  return out;
}

async function attachGraph(userId: string, draftId: string, file: OutgoingFile): Promise<void> {
  const base = `/me/messages/${encodeURIComponent(draftId)}/attachments`;
  if (file.content.byteLength <= GRAPH_SIMPLE_MAX_BYTES) {
    await graphApi(userId, 'POST', base, {
      '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.contentType, contentBytes: Buffer.from(file.content).toString('base64'),
    });
    return;
  }
  const session = (await graphApi(userId, 'POST', `${base}/createUploadSession`, {
    AttachmentItem: { attachmentType: 'file', name: file.name, size: file.content.byteLength, contentType: file.contentType },
  })) as { uploadUrl?: unknown };
  if (!isGraphUploadUrl(session.uploadUrl)) throw new Error('Microsoft 365 did not offer a place to upload the attachment.');
  const total = file.content.byteLength;
  for (const { start, end } of uploadRanges(total)) {
    // The session URL carries its own authorization; the account token is not sent to it.
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${total}` },
      body: file.content.slice(start, end + 1),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) await refused(res, 'Microsoft 365 attachment upload');
    await res.body?.cancel();
  }
}

async function sendGraph(userId: string, mail: FullSend): Promise<void> {
  const ours = mail.html ?? textAsHtml(mail.text);
  const recipients = {
    toRecipients: graphList(mail.recipients.to),
    ccRecipients: graphList(mail.recipients.cc),
    bccRecipients: graphList(mail.recipients.bcc),
  };
  let draftId: string | undefined;
  try {
    if (mail.replyTo) {
      // Outlook's reply draft threads the mail and holds the quoted original; ours goes above it.
      const draft = (await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(mail.replyTo)}/createReply`, {})) as { id?: string; body?: { contentType?: string; content?: string } };
      if (!draft.id) throw new Error('Microsoft 365 did not create the reply.');
      draftId = draft.id;
      const quoted = draft.body?.content ? (draft.body.contentType?.toLowerCase() === 'html' ? draft.body.content : textAsHtml(draft.body.content)) : '';
      await graphApi(userId, 'PATCH', `/me/messages/${encodeURIComponent(draftId)}`, { ...recipients, body: { contentType: 'HTML', content: `${ours}${quoted ? `<br>${quoted}` : ''}` } });
    } else {
      const draft = (await graphApi(userId, 'POST', '/me/messages', {
        subject: mail.subject.replace(/[\r\n]+/g, ' ').trim(), body: { contentType: 'HTML', content: ours }, ...recipients,
      })) as { id?: string };
      if (!draft.id) throw new Error('Microsoft 365 did not create the message.');
      draftId = draft.id;
    }
    for (const file of mail.attachments) await attachGraph(userId, draftId, file);
    await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(draftId)}/send`, {});
  } catch (err) {
    if (draftId) {
      // Best effort: a half-built draft must not stay in the owner's Drafts.
      await graphApi(userId, 'DELETE', `/me/messages/${encodeURIComponent(draftId)}`).catch(() => {});
    }
    throw err;
  }
}

/** Send a mail with HTML and/or attachments. The caller has checked `confirm` and the limits. */
export async function sendFull(userId: string, provider: EmailProvider, mail: FullSend): Promise<void> {
  if (provider === 'google') await sendGmail(userId, mail);
  else await sendGraph(userId, mail);
}
