/**
 * Sending a draft over the account's SMTP server (docs/MAIL.md#sending).
 *
 * A send is never automatic: the route needs an explicit confirmation and
 * the agent tool is ASK (an external effect). The draft is claimed first
 * (`MailRepo.claimForSend`: draft → sending in one statement), so one draft
 * goes out once; the outcome is recorded as sent or failed. A copy goes to
 * the IMAP account's Sent folder when it has one (best-effort).
 */
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { finishSend, type MailRepo } from '@/db/repositories/mail';
import type { MailAccount, MailMessage } from '@/db/schema/mail';
import type { MailAddress, MailServer } from '@/shared/mail';
import { coreLogger } from '@/utils/logger';
import { MailDeadlineError, withDeadline } from './deadline';
import { pinMailHost } from './hosts';
import { mailPassword, outgoingPassword } from './secrets';

/** Most recipients (to and cc together) one message may have. */
export const MAX_RECIPIENTS = 50;
const TIMEOUT_MS = 30_000;
/** The longest one send may take. */
const SEND_DEADLINE_MS = 3 * 60_000;

export class MailSendError extends Error {
  constructor(readonly code: 'not_found' | 'invalid' | 'failed', message: string) {
    super(message);
    this.name = 'MailSendError';
  }
}

function formatted(a: MailAddress): { name: string; address: string } | string {
  return a.name ? { name: a.name, address: a.address } : a.address;
}

/** The domain of an address, for a Message-ID of our own. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at >= 0 ? address.slice(at + 1).replace(/[^a-z0-9.-]/gi, '') : '';
  return domain || 'octipus.local';
}

/** Build the message: the same bytes go to SMTP and to the Sent folder. Pure but for the date. */
export async function composeMessage(account: Pick<MailAccount, 'address' | 'displayName'>, draft: Pick<MailMessage, 'toAddresses' | 'ccAddresses' | 'subject' | 'bodyText' | 'inReplyTo' | 'references'>): Promise<{ raw: Buffer; messageIdHeader: string; envelope: { from: string; to: string[] } }> {
  const messageIdHeader = `<${randomUUID()}@${domainOf(account.address)}>`;
  const composer = new MailComposer({
    from: account.displayName ? { name: account.displayName, address: account.address } : account.address,
    to: draft.toAddresses.map(formatted),
    cc: draft.ccAddresses.length > 0 ? draft.ccAddresses.map(formatted) : undefined,
    subject: draft.subject,
    text: draft.bodyText,
    messageId: messageIdHeader,
    inReplyTo: draft.inReplyTo ?? undefined,
    references: draft.references ?? undefined,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const node = composer.compile();
  const raw = await node.build();
  const env = node.getEnvelope();
  return { raw, messageIdHeader, envelope: { from: env.from || account.address, to: env.to } };
}

function transportFor(server: MailServer, address: string, servername: string | undefined, password: string) {
  return nodemailer.createTransport({
    host: address,
    port: server.port,
    secure: server.security === 'tls',
    requireTLS: server.security === 'starttls',
    ignoreTLS: server.security === 'none',
    tls: servername ? { servername } : undefined,
    auth: { user: server.username, pass: password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 2,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });
}

/** Log in to the outgoing server and leave: a settings check. */
export async function checkOutgoing(account: Pick<MailAccount, 'outgoing' | 'localNetwork'>, password: string): Promise<void> {
  const server = account.outgoing;
  if (!server) return;
  const pinned = await pinMailHost(server.host, server.security, account.localNetwork);
  const transport = transportFor(server, pinned.address, pinned.servername, password);
  try {
    await withDeadline(transport.verify(), SEND_DEADLINE_MS, 'The login check', () => transport.close());
  } finally {
    transport.close();
  }
}

/** Put a copy of a sent message into the IMAP account's Sent folder. Best-effort: never throws. */
async function appendToSent(account: MailAccount, raw: Buffer): Promise<void> {
  if (account.protocol !== 'imap') return;
  try {
    const password = await mailPassword(account.id, 'incoming');
    if (!password) return;
    const server = account.incoming;
    const pinned = await pinMailHost(server.host, server.security, account.localNetwork);
    const client = new ImapFlow({
      host: pinned.address,
      port: server.port,
      secure: server.security === 'tls',
      doSTARTTLS: server.security === 'starttls' ? true : server.security === 'none' ? false : undefined,
      servername: pinned.servername,
      tls: pinned.servername ? { servername: pinned.servername } : undefined,
      auth: { user: server.username, pass: password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: TIMEOUT_MS,
    });
    client.on('error', () => undefined);
    await client.connect();
    try {
      await withDeadline((async () => {
        const sent = (await client.list()).find((box) => box.specialUse === '\\Sent');
        if (sent) await client.append(sent.path, raw, ['\\Seen']);
      })(), SEND_DEADLINE_MS, 'The copy to Sent', () => client.close());
    } finally {
      await client.logout().catch(() => client.close());
    }
  } catch (err) {
    coreLogger.debug({ accountId: account.id, err: (err as Error).message }, 'mail: no copy in the Sent folder');
  }
}

/** Every recipient is a plain address; there is at least one and at most `MAX_RECIPIENTS`. */
function checkRecipients(draft: Pick<MailMessage, 'toAddresses' | 'ccAddresses'>): void {
  const all = [...draft.toAddresses, ...draft.ccAddresses];
  if (draft.toAddresses.length === 0) throw new MailSendError('invalid', 'The draft has no recipient');
  if (all.length > MAX_RECIPIENTS) throw new MailSendError('invalid', `A message can have at most ${MAX_RECIPIENTS} recipients`);
}

/**
 * Send draft `id` through `repo`'s scope. Returns the sent message's row id
 * and Message-ID; throws `MailSendError` (the draft is then `failed`, with
 * why, and can be sent again).
 */
export async function sendDraft(repo: MailRepo, id: string): Promise<{ id: string; messageIdHeader: string }> {
  const draft = await repo.message(id);
  if (!draft || (draft.status !== 'draft' && draft.status !== 'failed')) {
    throw new MailSendError('not_found', draft ? 'This message is not a draft' : 'Draft not found');
  }
  const account = await repo.account(draft.accountId);
  if (!account) throw new MailSendError('not_found', 'Mail account not found');
  if (!account.outgoing) throw new MailSendError('invalid', 'This mail account has no outgoing server');
  checkRecipients(draft);
  const claimed = await repo.claimForSend(id);
  if (!claimed) throw new MailSendError('not_found', 'The draft is already being sent');
  // What goes out is the claimed row: an edit between the check and the claim is checked again.
  try {
    checkRecipients(claimed);
  } catch (err) {
    await finishSend(id, { sent: false, error: (err as Error).message });
    throw err;
  }
  const outgoing = account.outgoing;
  let composed: Awaited<ReturnType<typeof composeMessage>>;
  try {
    const password = await outgoingPassword(account);
    if (!password) throw new Error('No password is stored for the outgoing server');
    const pinned = await pinMailHost(outgoing.host, outgoing.security, account.localNetwork);
    composed = await composeMessage(account, claimed);
    const { raw, envelope } = composed;
    const transport = transportFor(outgoing, pinned.address, pinned.servername, password);
    try {
      await withDeadline(transport.sendMail({ envelope, raw }), SEND_DEADLINE_MS, 'Sending', () => transport.close());
    } finally {
      transport.close();
    }
  } catch (err) {
    const message = err instanceof MailDeadlineError
      // The server may have taken the message before it went quiet.
      ? 'The server did not finish in time; the message may have gone out. Check the Sent folder before sending it again.'
      : (err as { response?: string; message?: string }).response || (err as Error).message || 'The message could not be sent';
    const error = message.replace(/\s+/g, ' ').trim().slice(0, 300);
    await finishSend(id, { sent: false, error });
    throw new MailSendError('failed', error);
  }
  // Accepted by the server: from here on it is sent. If recording that fails,
  // the row stays `sending` and the sweep marks it "may have gone out", never
  // "failed, send again".
  await finishSend(id, { sent: true, messageIdHeader: composed.messageIdHeader });
  coreLogger.info({ accountId: account.id, recipients: composed.envelope.to.length }, 'mail: message sent'); // no address or subject
  void appendToSent(account, composed.raw);
  return { id, messageIdHeader: composed.messageIdHeader };
}
