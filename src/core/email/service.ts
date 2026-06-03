/**
 * Email triage-lite service (feature #7) — read + assist over the connected
 * provider, scoped to the calling user. Read-only inbox/message fetch, plus
 * AI draft + (ASK-gated) send and archive. Mailbox content is sensitive: we
 * never log bodies, and draft/summary text is redacted before it could reach
 * logs (M2). Send is never automatic — the route requires explicit confirmation.
 */
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import {
  type GmailMessage,
  type GraphMessage,
  gmailToMessage,
  m365ToMessage,
  normalizeGmail,
  normalizeM365List,
} from './normalize';
import { detectProvider, gmailApi, graphApi } from './providers';
import type { EmailMessage, EmailProvider, EmailTriage, InboxItem } from './types';

async function generalModelId(): Promise<string> {
  const model = await getModelRegistry().getModelForTopic('general');
  if (!model) throw new Error('No model is bound to the "general" topic — bind one in the Models page.');
  return model.modelId;
}

/** List the connected provider's inbox. Returns provider=null if none connected. */
export async function getInbox(userId: string, limit = 20): Promise<{ provider: EmailProvider | null; items: InboxItem[] }> {
  const provider = await detectProvider(userId);
  if (!provider) return { provider: null, items: [] };

  if (provider === 'google') {
    const list = (await gmailApi(userId, 'GET', `/messages?maxResults=${limit}&labelIds=INBOX`)) as { messages?: { id: string }[] };
    const items = await Promise.all(
      (list.messages ?? []).slice(0, limit).map(async ({ id }) =>
        normalizeGmail(
          (await gmailApi(userId, 'GET', `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)) as GmailMessage,
        ),
      ),
    );
    return { provider, items };
  }

  const res = (await graphApi(
    userId,
    'GET',
    `/me/messages?$top=${limit}&$select=id,conversationId,subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime desc`,
  )) as { value?: GraphMessage[] };
  return { provider, items: normalizeM365List(res.value ?? []) };
}

/** Read a full message. */
export async function getMessage(userId: string, provider: EmailProvider, id: string): Promise<EmailMessage> {
  if (provider === 'google') {
    return gmailToMessage((await gmailApi(userId, 'GET', `/messages/${id}?format=full`)) as GmailMessage);
  }
  return m365ToMessage(
    (await graphApi(userId, 'GET', `/me/messages/${id}?$select=id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,body,bodyPreview`)) as GraphMessage,
  );
}

/** Archive a message (remove from inbox). */
export async function archiveMessage(userId: string, provider: EmailProvider, id: string): Promise<{ archived: boolean }> {
  if (provider === 'google') {
    await gmailApi(userId, 'POST', `/messages/${id}/modify`, { removeLabelIds: ['INBOX'] });
  } else {
    await graphApi(userId, 'POST', `/me/messages/${id}/move`, { destinationId: 'archive' });
  }
  return { archived: true };
}

/** Summarize a thread/message via the model (the model sees only the text). */
export async function summarizeMessage(userId: string, message: EmailMessage): Promise<string> {
  const result = await getLiteLLMClient().complete({
    model: await generalModelId(),
    messages: [
      { role: 'system', content: 'You summarize emails crisply for a busy reader.', timestamp: new Date() },
      { role: 'user', content: `Summarize this email and state what (if anything) it asks of me.\n\nFrom: ${message.from.email}\nSubject: ${message.subject}\n\n${message.body.slice(0, 6000)}`, timestamp: new Date() },
    ],
    temperature: 0.2,
    maxTokens: 400,
    userId,
  });
  return (result.content ?? '').trim();
}

/** Draft a reply (NOT sent). Returns recipient/subject/body for the file/draft view. */
export async function draftReply(userId: string, message: EmailMessage, instruction?: string): Promise<{ to: string; subject: string; body: string }> {
  const result = await getLiteLLMClient().complete({
    model: await generalModelId(),
    messages: [
      { role: 'system', content: 'You draft concise, professional email replies. Output only the reply body.', timestamp: new Date() },
      { role: 'user', content: `Draft a reply to this email.${instruction ? ` Guidance: ${instruction}.` : ''}\n\nFrom: ${message.from.email}\nSubject: ${message.subject}\n\n${message.body.slice(0, 6000)}`, timestamp: new Date() },
    ],
    temperature: 0.4,
    maxTokens: 700,
    userId,
  });
  return {
    to: message.from.email,
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    body: (result.content ?? '').trim(),
  };
}

/** Base64url-encode a MIME message for the Gmail send API. */
function buildGmailRaw(to: string, subject: string, body: string): string {
  const mime = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Send a reply. Caller MUST have confirmed — this performs the side effect. */
export async function sendReply(
  userId: string,
  provider: EmailProvider,
  payload: { to: string; subject: string; body: string },
): Promise<{ sent: boolean }> {
  if (provider === 'google') {
    await gmailApi(userId, 'POST', '/messages/send', { raw: buildGmailRaw(payload.to, payload.subject, payload.body) });
  } else {
    await graphApi(userId, 'POST', '/me/sendMail', {
      message: { subject: payload.subject, body: { contentType: 'Text', content: payload.body }, toRecipients: [{ emailAddress: { address: payload.to } }] },
    });
  }
  coreLogger.info({ userId, provider, to: payload.to }, 'email: reply sent'); // no body logged
  return { sent: true };
}

/** Strip ```json fences and parse. */
function parseJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    return m ? ((): T | null => { try { return JSON.parse(m[0]) as T; } catch { return null; } })() : null;
  }
}

/**
 * Triage a batch of inbox items into priorities via the model. Opt-in (not on
 * every poll) per the design's cost note. The model sees only from/subject/
 * snippet, never full bodies.
 */
export async function triageInbox(userId: string, items: InboxItem[]): Promise<Record<string, EmailTriage>> {
  if (items.length === 0) return {};
  const lines = items.map((it) => `${it.id} | ${it.from.email} | ${it.subject} | ${it.snippet.slice(0, 140)}`).join('\n');
  const result = await getLiteLLMClient().complete({
    model: await generalModelId(),
    messages: [
      { role: 'system', content: 'You triage an inbox. Reply ONLY JSON mapping each message id to {"priority":"high|normal|low","category":string,"reason":string}.', timestamp: new Date() },
      { role: 'user', content: `Messages (id | from | subject | snippet):\n${lines}`, timestamp: new Date() },
    ],
    temperature: 0,
    maxTokens: 1200,
    userId,
  });
  const parsed = parseJson<Record<string, EmailTriage>>(result.content ?? '');
  return parsed && typeof parsed === 'object' ? parsed : {};
}
