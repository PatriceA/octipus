/**
 * The inbound email channel (docs/CHANNELS.md#email): mail to a dedicated
 * IMAP mailbox becomes a conversation with Octipus, and the answer goes back
 * by mail, threaded under the mail it answers.
 *
 * No second mail stack: the mailbox is an ordinary mail account (Mail →
 * mailboxes, docs/MAIL.md) with its password in the vault. Received mail
 * comes in through the mail sync (`syncAccount`, run here every
 * `emailChannel.pollSeconds` as well as by the cron sweep) and answers go out
 * as drafts of that account sent by `sendDraft`, so they appear in its Sent
 * folder. What happens to each mail is decided in inbox.ts.
 *
 * The mailbox is the channel's alone: automatic triage skips it
 * (core/email/auto-triage.ts), so a mail the channel answers is never also
 * triaged or archived.
 */
import { eq } from 'drizzle-orm';
import { generateLinkCode } from '@/channels/linking';
import { getConfig } from '@/config';
import type { Config, EmailChannelConfig } from '@/config/schema';
import { isModuleOn } from '@/core/modules/registry';
import type { ChannelResponse, ChannelType } from '@/core/types';
import { getDb } from '@/db/postgres';
import { type MailAccount, mailAccounts } from '@/db/schema/mail';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';
import { replyReferences, replySubject } from './content';
import { handleInbound, type InboundOutcome, type InboxDeps, type InboxSettings } from './inbox';
import { dbEmailChannelStore, type EmailChannelStore, type InboundRecord } from './store';

/** Mail older than this when the channel first sees it is not answered (a first sync, a long outage). */
export const LOOKBACK_MS = 2 * 60 * 60_000;
/** Mails looked at per check. */
const BATCH = 20;
/** Dropped mail is recorded this long. */
const DROPPED_KEPT_MS = 30 * 24 * 60 * 60_000;
/** Marks the channel's answers as automatic (RFC 3834), so other robots do not answer them. */
export const REPLY_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-replied',
  'X-Auto-Response-Suppress': 'All',
};

/** Sends one plain-text reply to `to` from the channel's mailbox; returns its Message-ID. */
export type ReplySender = (account: MailAccount, to: InboundRecord, text: string) => Promise<string>;

/** The default sender: a draft of the account, sent over its SMTP server. */
export const sendReplyMail: ReplySender = async (account, to, text) => {
  const { contentRepos } = await import('@/db/repositories/content');
  const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
  const { sendDraft } = await import('@/core/mail/send');
  const repos = contentRepos(backgroundUserPrincipal(account.userId));
  const draft = await repos.mail.createDraft(account, {
    toAddresses: [{ address: to.address }],
    ccAddresses: [],
    subject: replySubject(to.subject),
    bodyText: text,
    inReplyTo: to.messageIdHeader,
    references: replyReferences(to.references, to.messageIdHeader),
  });
  const sent = await sendDraft(repos.mail, draft.id, undefined, { headers: { ...REPLY_HEADERS } });
  return sent.messageIdHeader;
};

export interface EmailChannelDeps {
  store: EmailChannelStore;
  account: (id: string) => Promise<MailAccount | null>;
  /** Fetch new mail of the account (the mail sync). */
  sync: (account: MailAccount) => Promise<unknown>;
  sendReply: ReplySender;
  linkedUser: InboxDeps['linkedUser'];
  linkCode: InboxDeps['linkCode'];
  now: () => Date;
}

const defaultDeps: EmailChannelDeps = {
  store: dbEmailChannelStore,
  account: async (id) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await getDb().select().from(mailAccounts).where(eq(mailAccounts.id, id)).limit(1);
    return row ?? null;
  },
  sync: async (account) => (await import('@/core/mail/sync')).syncAccount(account),
  sendReply: sendReplyMail,
  linkedUser: async (address) => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const user = await getChannelBindingManager().findUserRecordByExternalId('email', address);
    return user ? { id: user.id, username: user.username } : null;
  },
  linkCode: (address) => generateLinkCode({ channelType: 'email', channelUserId: address, channelUserName: address }),
  now: () => new Date(),
};

/** Why the configured account cannot serve the channel, or null. */
export function accountProblem(account: MailAccount | null): string | null {
  if (!account) return 'the mail account emailChannel.accountId names does not exist';
  if (account.workspaceId) return 'the mail account is a space\'s shared mailbox; use a personal one';
  if (account.protocol !== 'imap') return 'the mail account is not IMAP';
  if (!account.outgoing) return 'the mail account has no outgoing (SMTP) server';
  if (!account.enabled) return 'the mail account is disabled';
  return null;
}

export class EmailChannel extends BaseChannel {
  readonly type: ChannelType = 'email';
  readonly name = 'Email';
  override readonly interactive = false;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private account: MailAccount | null = null;
  private settings: EmailChannelConfig | null = null;

  constructor(private readonly deps: EmailChannelDeps = defaultDeps) {
    super();
  }

  override isEnabled(config: Config): boolean {
    const c = config.emailChannel;
    return Boolean(c?.enabled && c.accountId) && isModuleOn('mail');
  }

  async connect(): Promise<void> {
    const settings = getConfig().emailChannel;
    const account = await this.deps.account(settings.accountId);
    const problem = accountProblem(account);
    if (problem || !account) {
      channelLogger.error({ accountId: settings.accountId, problem }, 'Email channel not started');
      return;
    }
    if (settings.trustedAuthservIds.length === 0) {
      channelLogger.warn('Email channel: emailChannel.trustedAuthservIds is empty, so no mail can pass authentication and every mail is dropped');
    }
    this.account = account;
    this.settings = settings;
    this.setConnected(true);
    this.timer = setInterval(() => { void this.check(); }, settings.pollSeconds * 1000);
    this.timer.unref?.();
    void this.check();
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
    this.account = null;
    this.settings = null;
    if (this.connected) this.setConnected(false);
  }

  /** Test seam: start with this account and these settings, without a timer. */
  start(account: MailAccount, settings: EmailChannelConfig): void {
    this.account = account;
    this.settings = settings;
    this.setConnected(true);
  }

  /** One check: fetch new mail, then decide on each mail not looked at yet. Never two at once. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.checkOnce()
      .catch((err: unknown) => channelLogger.error({ err }, 'Email channel check failed'))
      .finally(() => { this.running = null; });
    return this.running;
  }

  private inboxSettings(account: MailAccount, emailChannel: EmailChannelConfig): InboxSettings {
    return {
      accountId: account.id,
      ownAddress: account.address,
      allowedSenders: emailChannel.allowedSenders,
      trustedAuthservIds: emailChannel.trustedAuthservIds,
      maxMessageBytes: emailChannel.maxMessageBytes,
      maxPerSenderPerHour: emailChannel.maxPerSenderPerHour,
    };
  }

  private async checkOnce(): Promise<void> {
    const account = this.account;
    const settings = this.settings;
    if (!account || !settings) return;
    const fresh = await this.deps.account(account.id);
    if (fresh) {
      this.account = fresh;
      const due = !fresh.lastSyncAt || this.deps.now().getTime() - fresh.lastSyncAt.getTime() >= settings.pollSeconds * 1000;
      if (due) await this.deps.sync(fresh);
    }
    const { store } = this.deps;
    const now = this.deps.now();
    const inbox = this.inboxSettings(account, settings);
    const deps: InboxDeps = {
      store,
      linkedUser: this.deps.linkedUser,
      linkCode: this.deps.linkCode,
      notice: async (to, text) => { await this.reply(to, text); },
      now: this.deps.now,
    };
    for (const mail of await store.unseen(account.id, new Date(now.getTime() - LOOKBACK_MS), BATCH)) {
      let outcome: InboundOutcome;
      try {
        outcome = await handleInbound(mail, inbox, deps);
      } catch (err) {
        channelLogger.error({ err, mailMessageId: mail.id }, 'Email channel could not handle a mail');
        continue;
      }
      // Reasons and ids only: no address, subject or body is logged.
      if (outcome.kind === 'dropped') channelLogger.info({ mailMessageId: mail.id, reason: outcome.reason }, 'Email channel dropped a mail');
      if (outcome.kind !== 'turn') continue;
      const { turn } = outcome;
      this.emitMessage(this.createUnifiedMessage(turn.threadKey, turn.userId, turn.content, {
        userName: turn.address,
        threadId: turn.threadKey,
        attachments: turn.attachments.length ? turn.attachments : undefined,
        metadata: { messageId: turn.recordId },
      }));
    }
    await store.pruneDropped(account.id, new Date(now.getTime() - DROPPED_KEPT_MS));
  }

  /** Send `text` in reply to an inbound mail and record it (its Message-ID continues the thread). */
  private async reply(to: InboundRecord, text: string): Promise<string> {
    const account = this.account;
    if (!account) throw new Error('Email channel not connected');
    const base = { accountId: account.id, address: to.address, userId: to.userId, threadKey: to.threadKey };
    try {
      const messageIdHeader = await this.deps.sendReply(account, to, text);
      await this.deps.store.recordOutbound({ ...base, messageIdHeader, status: 'sent' });
      return messageIdHeader;
    } catch (err) {
      await this.deps.store.recordOutbound({ ...base, messageIdHeader: null, status: 'failed', reason: String((err as Error).message ?? err).slice(0, 300) });
      throw err;
    }
  }

  /**
   * The answer of a turn: one mail to the sender of the mail it answers
   * (`replyTo`, the channel's record of it) or of the thread's newest mail.
   * Never to anyone else: not `Reply-To`, not `Cc`. Files the turn made
   * stay in the web app; the mail says so.
   */
  async send(channelId: string, response: ChannelResponse): Promise<string> {
    const account = this.account;
    if (!account) throw new Error('Email channel not connected');
    const target = await this.deps.store.replyTarget(account.id, channelId, response.replyTo);
    if (!target) throw new Error('Email channel: no mail of this conversation to answer');
    let text = response.content;
    if (response.attachments?.length) {
      for (const a of response.attachments) (response.undelivered ??= []).push({ filename: a.filename, type: a.type, error: 'files are not sent by mail' });
      text += `\n\n(${response.attachments.length} file(s) from this answer are in the Octipus web app.)`;
    }
    return this.reply(target, text);
  }
}

export const emailChannel = new EmailChannel();
