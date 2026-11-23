/**
 * The inbound email channel (docs/CHANNELS.md#email): mail to a dedicated
 * IMAP mailbox becomes a conversation with Octipus, and the answer is a reply
 * threaded under the mail it answers — saved as a draft for a person to send
 * (`emailChannel.replyMode: draft`, the default) or sent at once (`send`).
 *
 * No second mail stack: the mailbox is an ordinary mail account (Mail →
 * mailboxes, docs/MAIL.md) with its password in the vault, owned by an admin.
 * It is read and written through the mail repository as that admin
 * (`MailRepo`): new mail comes in through the mail sync (`syncAccount`, run
 * here every `emailChannel.pollSeconds` as well as by the cron sweep), and
 * answers are drafts of that account, sent by `sendDraft` in send mode. What
 * happens to each mail is decided in inbox.ts.
 *
 * The mailbox is the channel's alone: automatic triage and the owner's mail
 * tool skip it (core/mail/channel-mailbox.ts), so a mail the channel handles
 * is never also triaged, archived or read by the owner's agent.
 */
import { generateLinkCode } from '@/channels/linking';
import { getConfig } from '@/config';
import type { Config, EmailChannelConfig } from '@/config/schema';
import { isModuleOn } from '@/core/modules/registry';
import type { ChannelResponse, ChannelType } from '@/core/types';
import type { MailAccount } from '@/db/schema/mail';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';
import { replyReferences, replySubject } from './content';
import { attachmentsNotRead, handleInbound, type InboundOutcome, type InboxDeps, type InboxSettings, type NoticeKind } from './inbox';
import { dbEmailChannelStore, type EmailChannelStore, type InboundRecord } from './store';

/** Mail that arrived longer ago than this when the channel reaches it is recorded and not answered. */
export const LOOKBACK_MS = 2 * 60 * 60_000;
/** Stored mail is looked at for this long after it was stored (well past the lookback, so nothing ages out unrecorded). */
const UNSEEN_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Mails read per query, and the most one check handles; the rest waits for the next check. */
const BATCH = 50;
const MAX_PER_CHECK = 1000;
/** Retention of the channel's records. */
const DROPPED_KEPT_MS = 30 * 24 * 60 * 60_000;
const RECORDS_KEPT_MS = 90 * 24 * 60 * 60_000;
const UNLINKED_SCRUB_MS = 24 * 60 * 60_000;
/** Marks the channel's sent answers as automatic (RFC 3834), so other robots do not answer them. */
export const REPLY_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-replied',
  'X-Auto-Response-Suppress': 'All',
};

/** A reply as the mail stack takes it: to the sender only, `Re:`, threaded. */
export function replyMessage(to: InboundRecord, text: string) {
  return {
    toAddresses: [{ address: to.address }],
    ccAddresses: [],
    subject: replySubject(to.subject),
    bodyText: text,
    inReplyTo: to.messageIdHeader,
    references: replyReferences(to.references, to.messageIdHeader),
  };
}

/** The channel's mailbox, read and written as its admin owner. */
export interface ChannelMailbox {
  account: MailAccount;
  unseen(since: Date, limit: number): Promise<Array<{ id: string; size: number; date: Date }>>;
  raw(mailMessageId: string): Promise<Buffer | null>;
  /** Save a reply as a draft of the account; returns the draft's id. */
  draft(to: InboundRecord, text: string): Promise<string>;
  /** Save and send a reply (Sent folder); returns the message's id and Message-ID. */
  send(to: InboundRecord, text: string): Promise<{ mailMessageId: string; messageIdHeader: string }>;
  /** Send without keeping a copy anywhere (a link code); returns the Message-ID. */
  sendUnstored(to: InboundRecord, text: string): Promise<string>;
}

/** Why the configured account cannot serve the channel, or null. */
export function accountProblem(account: MailAccount | null): string | null {
  if (!account) return 'the mail account emailChannel.accountId names is not a personal mailbox of an admin';
  if (account.protocol !== 'imap') return 'the mail account is not IMAP';
  if (!account.outgoing) return 'the mail account has no outgoing (SMTP) server';
  if (!account.enabled) return 'the mail account is disabled';
  return null;
}

/**
 * The mailbox `accountId` names, when it is a personal mailbox of an active
 * admin: found through each admin's own mail repository, so any other
 * user's mailbox is never reached (a setting cannot point the channel at
 * someone else's mail).
 */
export async function adminMailbox(accountId: string): Promise<ChannelMailbox | null> {
  const [{ userRepository }, { contentRepos }, { backgroundUserPrincipal }, send] = await Promise.all([
    import('@/db/repositories/user-repository'), import('@/db/repositories/content'),
    import('@/core/tasks/sourced'), import('@/core/mail/send'),
  ]);
  for (const admin of await userRepository.listAdmins()) {
    const mail = contentRepos(backgroundUserPrincipal(admin.id)).mail;
    const account = await mail.account(accountId);
    // The admin's personal scope: their own mailboxes, never a space's (a personal account may sit in their personal workspace).
    if (!account || account.userId !== admin.id) continue;
    return {
      account,
      unseen: (since, limit) => mail.channelUnseen(account.id, since, limit),
      raw: (id) => mail.raw(id),
      draft: async (to, text) => (await mail.createDraft(account, replyMessage(to, text))).id,
      send: async (to, text) => {
        const draft = await mail.createDraft(account, replyMessage(to, text));
        const sent = await send.sendDraft(mail, draft.id, undefined, { headers: { ...REPLY_HEADERS } });
        return { mailMessageId: sent.id, messageIdHeader: sent.messageIdHeader };
      },
      sendUnstored: (to, text) => send.sendUnstored(account, replyMessage(to, text), { ...REPLY_HEADERS }),
    };
  }
  return null;
}

export interface EmailChannelDeps {
  store: EmailChannelStore;
  mailbox: (accountId: string) => Promise<ChannelMailbox | null>;
  /** Fetch new mail of the account (the mail sync). */
  sync: (account: MailAccount) => Promise<unknown>;
  linkedUser: InboxDeps['linkedUser'];
  linkCode: InboxDeps['linkCode'];
  now: () => Date;
}

const defaultDeps: EmailChannelDeps = {
  store: dbEmailChannelStore,
  mailbox: adminMailbox,
  sync: async (account) => (await import('@/core/mail/sync')).syncAccount(account),
  linkedUser: async (address) => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const user = await getChannelBindingManager().findUserRecordByExternalId('email', address);
    return user && user.isActive !== false ? { id: user.id, username: user.username } : null;
  },
  linkCode: (address) => generateLinkCode({ channelType: 'email', channelUserId: address, channelUserName: address }),
  now: () => new Date(),
};

export class EmailChannel extends BaseChannel {
  readonly type: ChannelType = 'email';
  readonly name = 'Email';
  override readonly interactive = false;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private mailbox: ChannelMailbox | null = null;
  private settings: EmailChannelConfig | null = null;
  /** Files a mail had that were not read, by the channel's record of it: named in its answer. */
  private readonly ignoredAttachments = new Map<string, string[]>();

  constructor(private readonly deps: EmailChannelDeps = defaultDeps) {
    super();
  }

  override isEnabled(config: Config): boolean {
    const c = config.emailChannel;
    return Boolean(c?.enabled && c.accountId) && isModuleOn('mail');
  }

  async connect(): Promise<void> {
    const emailChannel = getConfig().emailChannel;
    if (!(await this.open(emailChannel))) return;
    this.timer = setInterval(() => { void this.check(); }, emailChannel.pollSeconds * 1000);
    this.timer.unref?.();
    void this.check();
  }

  /** Take the configured mailbox if it can serve the channel; false (logged) when not. */
  async open(emailChannel: EmailChannelConfig): Promise<boolean> {
    const mailbox = await this.deps.mailbox(emailChannel.accountId);
    const problem = accountProblem(mailbox?.account ?? null);
    if (problem || !mailbox) {
      channelLogger.error({ accountId: emailChannel.accountId, problem }, 'Email channel not started');
      return false;
    }
    if (emailChannel.trustedAuthservIds.length === 0) {
      channelLogger.warn('Email channel: emailChannel.trustedAuthservIds is empty, so no mail can pass authentication and every mail is dropped');
    }
    this.mailbox = mailbox;
    this.settings = emailChannel;
    this.setConnected(true);
    return true;
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.running?.catch(() => undefined);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mailbox = null;
    this.settings = null;
    if (this.connected) this.setConnected(false);
  }

  /** One check: fetch new mail, then decide on each mail not looked at yet. Never two at once. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.checkOnce()
      .catch((err: unknown) => channelLogger.error({ err }, 'Email channel check failed'))
      .finally(() => { this.running = null; });
    return this.running;
  }

  private async checkOnce(): Promise<void> {
    const emailChannel = this.settings;
    if (!this.mailbox || !emailChannel) return;
    // Every check reads the mailbox again: one disabled, moved to a space, given
    // to another owner or stripped of its server since stops the channel.
    const mailbox = await this.deps.mailbox(emailChannel.accountId);
    const problem = accountProblem(mailbox?.account ?? null);
    if (problem || !mailbox) {
      channelLogger.error({ accountId: emailChannel.accountId, problem }, 'Email channel stopped: its mailbox can no longer serve it');
      this.stop();
      return;
    }
    this.mailbox = mailbox;
    const { account } = mailbox;
    const due = !account.lastSyncAt || this.deps.now().getTime() - account.lastSyncAt.getTime() >= emailChannel.pollSeconds * 1000;
    if (due) await this.deps.sync(account);
    const now = this.deps.now();
    const inbox: InboxSettings = {
      accountId: account.id,
      ownAddress: account.address,
      allowedSenders: emailChannel.allowedSenders,
      trustedAuthservIds: emailChannel.trustedAuthservIds,
      maxMessageBytes: emailChannel.maxMessageBytes,
      maxPerSenderPerHour: emailChannel.maxPerSenderPerHour,
      lookbackMs: LOOKBACK_MS,
    };
    const deps: InboxDeps = {
      store: this.deps.store,
      raw: (id) => mailbox.raw(id),
      linkedUser: this.deps.linkedUser,
      linkCode: this.deps.linkCode,
      notice: async (to, text, kind) => { await this.reply(to, text, kind); },
      now: this.deps.now,
    };
    // Drain: everything new, a batch at a time, up to the per-check bound.
    // Mail the channel reaches too late is recorded as `too_old`, never skipped silently.
    let handled = 0;
    while (handled < MAX_PER_CHECK) {
      const batch = await mailbox.unseen(new Date(now.getTime() - UNSEEN_WINDOW_MS), BATCH);
      if (batch.length === 0) break;
      for (const mail of batch) {
        handled++;
        let outcome: InboundOutcome;
        try {
          outcome = await handleInbound(mail, inbox, deps);
        } catch (err) {
          channelLogger.error({ err, mailMessageId: mail.id }, 'Email channel could not handle a mail; recorded as dropped (error)');
          continue;
        }
        // Reasons and ids only: no address, subject or body is logged.
        if (outcome.kind === 'dropped') channelLogger.info({ mailMessageId: mail.id, reason: outcome.reason }, 'Email channel dropped a mail');
        if (outcome.kind !== 'turn') continue;
        const { turn } = outcome;
        if (turn.ignoredAttachments.length) {
          this.ignoredAttachments.set(turn.recordId, turn.ignoredAttachments);
          if (this.ignoredAttachments.size > 1000) this.ignoredAttachments.delete(this.ignoredAttachments.keys().next().value as string);
        }
        this.emitMessage(this.createUnifiedMessage(turn.threadKey, turn.userId, turn.content, {
          userName: turn.address,
          threadId: turn.threadKey,
          metadata: { messageId: turn.recordId },
        }));
      }
    }
    await this.deps.store.prune(account.id, {
      droppedBefore: new Date(now.getTime() - DROPPED_KEPT_MS),
      before: new Date(now.getTime() - RECORDS_KEPT_MS),
      scrubBefore: new Date(now.getTime() - UNLINKED_SCRUB_MS),
    });
  }

  /**
   * Answer an inbound mail and record it. Draft mode saves a draft for a
   * person to send; send mode sends it. A link code in send mode is sent
   * without a copy (no Sent folder, no row) so it never sits in the
   * mailbox; in draft mode it is a draft like any answer.
   */
  private async reply(to: InboundRecord, text: string, kind?: NoticeKind): Promise<string> {
    const mailbox = this.mailbox;
    const emailChannel = this.settings;
    if (!mailbox || !emailChannel) throw new Error('Email channel not connected');
    const base = { accountId: mailbox.account.id, address: to.address, userId: to.userId, threadKey: to.threadKey };
    try {
      if (emailChannel.replyMode !== 'send') {
        const draftId = await mailbox.draft(to, text);
        await this.deps.store.recordOutbound({ ...base, mailMessageId: draftId, messageIdHeader: null, status: 'drafted' });
        return draftId;
      }
      if (kind === 'link_code') {
        const messageIdHeader = await mailbox.sendUnstored(to, text);
        await this.deps.store.recordOutbound({ ...base, mailMessageId: null, messageIdHeader, status: 'sent' });
        return messageIdHeader;
      }
      const sent = await mailbox.send(to, text);
      await this.deps.store.recordOutbound({ ...base, ...sent, status: 'sent' });
      return sent.messageIdHeader;
    } catch (err) {
      await this.deps.store.recordOutbound({ ...base, mailMessageId: null, messageIdHeader: null, status: 'failed', reason: String((err as Error).message ?? err).slice(0, 300) });
      throw err;
    }
  }

  /**
   * The answer of a turn: one reply to the sender of the mail it answers
   * (`replyTo`, the channel's record of it) or of the thread's newest mail —
   * only while that address is still linked to the conversation's user.
   * Never to anyone else: not `Reply-To`, not `Cc`. Files the turn made
   * stay in the web app; the mail says so.
   */
  async send(channelId: string, response: ChannelResponse): Promise<string> {
    const mailbox = this.mailbox;
    if (!mailbox) throw new Error('Email channel not connected');
    const target = await this.deps.store.replyTarget(mailbox.account.id, channelId, response.replyTo);
    if (!target) throw new Error('Email channel: no mail of this conversation to answer');
    const linked = await this.deps.linkedUser(target.address);
    if (!target.userId || linked?.id !== target.userId) throw new Error('Email channel: the address of this conversation is no longer linked to its user');
    let text = response.content;
    const ignored = this.ignoredAttachments.get(target.id);
    if (ignored) {
      this.ignoredAttachments.delete(target.id);
      text += `\n\n${attachmentsNotRead(ignored)}`;
    }
    if (response.attachments?.length) {
      for (const a of response.attachments) (response.undelivered ??= []).push({ filename: a.filename, type: a.type, error: 'files are not sent by mail' });
      text += `\n\n(${response.attachments.length} file(s) from this answer are in the Octipus web app.)`;
    }
    return this.reply(target, text);
  }
}

export const emailChannel = new EmailChannel();
