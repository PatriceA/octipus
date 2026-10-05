import { Bot, type Context, InputFile } from 'grammy';
import { BUFFER_BOT_ID, findGroupMessage, forgetGroupChat, groupMessages, recordGroupMessage } from '@/channels/group-buffer';
import { type GroupDeps, type GroupMember, groupHints, handleGroupMessage, MAIN_THREAD } from '@/channels/group-handler';
import { shouldSendHint } from '@/channels/hint-limiter';
import { generateLinkCode } from '@/channels/linking';
import { getConfig } from '@/config';
import type { Config } from '@/config/schema';
import type { Attachment, ChannelResponse, ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';
import {
  isGroupChat, type TelegramMessageLike, telegramName, telegramPermalink, telegramThread, toTelegramGroupInbound,
} from './group';

const HINTS = groupHints({
  platform: 'Telegram',
  linkHow: 'send me /link in a private chat',
  takeAlso: 'or reply to a message with `@Octipus take this`',
  followHow: 'reply to my messages to continue',
});

export class TelegramChannel extends BaseChannel {
  readonly type: ChannelType = 'telegram';
  readonly name = 'Telegram';

  private bot: Bot | null = null;
  private allowedUsers: Set<string> = new Set();
  /** Enrolled groups seen since start: the bot's replies there join the transcript. */
  private groupChats = new Set<string>();
  /** Members' names as last seen in groups, by Telegram user id. */
  private names = new Map<string, string>();

  override isEnabled(config: Config): boolean {
    return Boolean(config.telegram?.botToken);
  }

  async connect(): Promise<void> {
    const config = getConfig();

    if (!config.telegram?.botToken) {
      channelLogger.warn('Telegram bot token not configured');
      return;
    }

    this.bot = new Bot(config.telegram.botToken);
    this.allowedUsers = new Set(config.telegram.allowedUsers || []);

    // Set up message handlers
    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx);
    });

    this.bot.on('message:photo', async (ctx) => {
      await this.handleMessage(ctx, 'photo');
    });

    this.bot.on('message:document', async (ctx) => {
      await this.handleMessage(ctx, 'document');
    });

    this.bot.on('message:voice', async (ctx) => {
      await this.handleMessage(ctx, 'voice');
    });

    // A group upgraded to a supergroup gets a new chat id: keep its enrolment.
    this.bot.on('message:migrate_to_chat_id', async (ctx) => {
      const from = String(ctx.chat.id);
      const to = String(ctx.message.migrate_to_chat_id);
      try {
        const { moveGroupChannel } = await import('@/channels/group-channels');
        await moveGroupChannel('telegram', from, to);
        this.groupChats.delete(from);
        forgetGroupChat('telegram', from);
      } catch (err) {
        channelLogger.error({ err, from, to }, 'Could not move the Telegram group enrolment to its new chat id');
      }
    });

    // Error handling
    this.bot.catch((err) => {
      this.emitError(err.error as Error);
    });

    // Start polling. grammY's bot.start() resolves only when polling STOPS, so
    // we must NOT await it — but we MUST attach a .catch, or an auth failure
    // (e.g. a bad/expired token returning 401) is dropped silently and the
    // channel never connects with no error surfaced (House Rule #1, fail loud).
    this.bot.start({
      onStart: (botInfo) => {
        channelLogger.info({ username: botInfo.username }, 'Telegram bot started');
        this.setConnected(true);
      },
    }).catch((error) => {
      channelLogger.error({ err: error }, 'Telegram polling failed — check that the bot token is valid');
      this.emitError(error as Error);
    });
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
      this.setConnected(false);
    }
  }

  async send(channelId: string, response: ChannelResponse): Promise<string> {
    if (!this.bot) {
      throw new Error('Telegram bot not connected');
    }

    const chatId = parseInt(channelId, 10);

    // Send attachments first
    if (response.attachments?.length) {
      for (const attachment of response.attachments) {
        await this.sendAttachment(chatId, attachment, response.replyTo, response.threadId);
      }
    }

    // Send text message — split into chunks if over Telegram's 4096 char limit
    const MAX_LEN = 4096;
    const chunks = this.splitMessage(response.content, MAX_LEN);
    let lastMessageId = '';
    const sentIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const options: Record<string, unknown> = {
        parse_mode: 'Markdown',
      };
      // A forum topic is a group thread; a plain group is one (`main`).
      if (response.threadId && /^\d+$/.test(response.threadId)) {
        options.message_thread_id = parseInt(response.threadId, 10);
      }

      // Only set reply-to on the first chunk
      if (i === 0 && response.replyTo) {
        options.reply_to_message_id = parseInt(response.replyTo, 10);
      }

      try {
        const result = await this.bot.api.sendMessage(chatId, chunks[i], options);
        lastMessageId = String(result.message_id);
        sentIds.push(lastMessageId);
      } catch (err: any) {
        if (err?.error_code === 400) {
          if (options.reply_to_message_id) {
            delete options.reply_to_message_id;
          }
          if (err?.description?.includes("can't parse entities")) {
            delete options.parse_mode;
          }
          const result = await this.bot.api.sendMessage(chatId, chunks[i], options);
          lastMessageId = String(result.message_id);
          sentIds.push(lastMessageId);
        } else {
          throw err;
        }
      }
    }

    if (this.groupChats.has(channelId)) {
      // One entry per message sent, so a reply to any part is found as the bot's.
      sentIds.forEach((id, i) => recordGroupMessage('telegram', channelId, response.threadId ?? MAIN_THREAD, {
        id, conversationId: channelId, author: 'Octipus', authorId: BUFFER_BOT_ID, text: chunks[i] ?? '', at: new Date().toISOString(),
      }));
    }
    return lastMessageId;
  }

  /** A direct message to a Telegram user; false when they never started a chat with the bot. */
  private async sendDirect(telegramUserId: string, text: string): Promise<boolean> {
    if (!this.bot) return false;
    try {
      await this.send(telegramUserId, { content: text });
      return true;
    } catch (err) {
      channelLogger.debug({ err }, 'Telegram direct message failed (the user may not have started a chat with the bot)');
      return false;
    }
  }

  /** The approval details etc. for a group: in the member's private chat with the bot. */
  override async sendPrivate(_channelId: string, userId: string, response: ChannelResponse): Promise<boolean> {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const identities = (await getChannelBindingManager().listForUser(userId))
      .filter(i => i.channelType === 'telegram' && i.verifiedAt);
    let delivered = false;
    for (const identity of identities) {
      if (await this.sendDirect(identity.externalId, response.content)) delivered = true;
    }
    return delivered;
  }

  /** Platform calls for `handleGroupMessage`, for one group message. */
  private groupDeps(ctx: Context, attachmentType?: string): GroupDeps<Context> {
    const me = ctx.me;
    const botUserId = String(me.id);
    return {
      botUserId,
      bot: `@${me.username}`,
      hints: HINTS,
      findGroup: async (chatId) => {
        const { findGroupChannel } = await import('@/channels/group-channels');
        return findGroupChannel('telegram', chatId);
      },
      isGroupActive: async (group) => {
        const { isGroupChannelActive } = await import('@/channels/group-channels');
        return isGroupChannelActive(group);
      },
      isThreadActive: async (groupId, threadId) => {
        const { isGroupThreadActive } = await import('@/channels/group-channels');
        return isGroupThreadActive(groupId, threadId);
      },
      findMember: async (telegramUserId): Promise<GroupMember | null> => {
        const { getChannelBindingManager } = await import('@/security/channel-bindings');
        const user = await getChannelBindingManager().findUserRecordByExternalId('telegram', telegramUserId);
        return user ? { id: user.id, username: user.username, isActive: user.isActive, isAdmin: user.isAdmin } : null;
      },
      join: async ({ channelId, label, userId }) => {
        const { joinGroupChannel } = await import('@/channels/group-channels');
        return joinGroupChannel({ channelType: 'telegram', channelId, label, userId });
      },
      leave: async ({ channelId, userId, isAdmin }) => {
        const { leaveGroupChannel } = await import('@/channels/group-channels');
        return leaveGroupChannel({ channelType: 'telegram', channelId, userId, isAdmin });
      },
      channelLabel: async () => (ctx.chat && 'title' in ctx.chat ? ctx.chat.title ?? null : null),
      displayName: async (telegramUserId) => this.names.get(telegramUserId) ?? 'a member',
      postPrivate: async (telegramUserId, text, where) => {
        if (await this.sendDirect(telegramUserId, text)) return;
        // They never opened a private chat with the bot: answer their message
        // in place. The hints carry no secrets (never a link code).
        await this.send(where.channelId, { content: text, replyTo: where.messageId, threadId: telegramThread(ctx.message ?? {}) })
          .catch((err: unknown) => channelLogger.error({ err }, 'Telegram group: hint failed'));
      },
      postInThread: async (chatId, threadId, text) => {
        await this.send(chatId, { content: text, threadId })
          .catch((err: unknown) => channelLogger.error({ err }, 'Telegram group: posting failed'));
      },
      readContext: async ({ channelId, messageId, replyThread, label }) => {
        const { renderGroupContext } = await import('@/core/channels/group-context');
        return renderGroupContext(groupMessages('telegram', channelId, replyThread), {
          currentMessageId: messageId,
          botIds: new Set([BUFFER_BOT_ID]),
          conversationName: label ?? undefined,
          scope: replyThread === MAIN_THREAD ? 'channel' : 'thread',
        });
      },
      readMessage: async (chatId, id) => {
        const m = findGroupMessage('telegram', chatId, telegramThread(ctx.message ?? {}), id);
        return m ? { text: m.text, user: m.authorId === BUFFER_BOT_ID ? botUserId : m.authorId ?? null } : null;
      },
      permalink: async (chatId, id) => telegramPermalink(chatId, id),
      budgetPause: async (group, scope) => {
        const { groupChannelPause } = await import('@/security/spend-budgets');
        return groupChannelPause(group.id, scope).catch((err: unknown) => {
          channelLogger.warn({ err, groupId: group.id }, 'Group channel budget check failed — not pausing');
          return null;
        });
      },
      shouldSendHint: (key) => shouldSendHint(`telegram:${key}`),
      forget: (chatId) => {
        this.groupChats.delete(chatId);
        forgetGroupChat('telegram', chatId);
      },
      seen: (msg) => {
        this.groupChats.add(msg.channelId);
        const at = new Date((ctx.message?.date ?? Date.now() / 1000) * 1000).toISOString();
        // The message replied to is often the only way the bot sees it (privacy mode).
        const reply = msg.replyTo;
        if (reply?.text && !findGroupMessage('telegram', msg.channelId, msg.replyThread, reply.id)) {
          const from = ctx.message?.reply_to_message?.from;
          recordGroupMessage('telegram', msg.channelId, msg.replyThread, {
            id: reply.id, conversationId: msg.channelId,
            author: reply.user === botUserId ? 'Octipus' : telegramName(from),
            authorId: reply.user === botUserId ? BUFFER_BOT_ID : reply.user ?? undefined,
            text: reply.text,
            at: new Date((ctx.message?.reply_to_message?.date ?? Date.now() / 1000) * 1000).toISOString(),
          });
        }
        if (msg.text) {
          recordGroupMessage('telegram', msg.channelId, msg.replyThread, {
            id: msg.messageId, conversationId: msg.channelId, author: this.names.get(msg.user) ?? 'a member', authorId: msg.user,
            text: msg.text, at, addressed: msg.mentioned || msg.repliedToBot === true,
          });
        }
      },
      dispatch: async ({ channelId, member, userName, text, threadId, group, context, message, take }) => {
        const attachments = await this.extractAttachments(ctx, attachmentType).catch((err: unknown) => {
          channelLogger.warn({ err }, 'Telegram group: reading the attachment failed');
          return [] as Attachment[];
        });
        this.emitMessage(this.createUnifiedMessage(channelId, member.id, text, {
          userName,
          threadId,
          attachments: attachments.length > 0 ? attachments : undefined,
          metadata: {
            telegramUserId: message.user,
            // Replies and the progress reactions go on this message.
            messageId: message.messageId,
            groupChannelId: group.id,
            groupContext: context,
            ...(take ? { take } : {}),
          },
        }));
      },
    };
  }

  override async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMessageReaction(parseInt(channelId, 10), parseInt(messageId, 10), [
        { type: 'emoji', emoji: emoji as any },
      ]);
    } catch (err: any) {
      // Silently ignore — reaction failures are non-critical (bot may lack permissions)
      channelLogger.debug({ err: err?.message, channelId, messageId, emoji }, 'Failed to set Telegram reaction');
    }
  }

  override async sendTyping(channelId: string, _active: boolean = true): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(parseInt(channelId, 10), 'typing');
    } catch {
      // Silently ignore
    }
  }

  private async handleMessage(ctx: Context, attachmentType?: string): Promise<void> {
    const userId = String(ctx.from?.id);
    const chatId = String(ctx.chat?.id);
    const userName = ctx.from?.username || ctx.from?.first_name;

    // Groups follow the group-channel rules: silent unless enrolled and
    // addressed, and `/link` never answered there. Only private chats take
    // the path below.
    if (isGroupChat(ctx.chat)) {
      // `allowedUsers` limits who may use the bot, not which groups it is in:
      // other senders are ignored, without a reply in front of everyone.
      if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) return;
      const message = ctx.message as TelegramMessageLike | undefined;
      const inbound = message ? toTelegramGroupInbound(message, { id: ctx.me.id, username: ctx.me.username }, ctx) : null;
      if (!inbound) return;
      this.names.delete(inbound.user); // re-insert: Map order doubles as LRU order
      this.names.set(inbound.user, telegramName(message?.from));
      if (this.names.size > 5_000) this.names.delete(this.names.keys().next().value as string);
      try {
        await handleGroupMessage(inbound, this.groupDeps(ctx, attachmentType));
      } catch (err) {
        channelLogger.error({ err, chatId }, 'Telegram group message handling failed');
      }
      return;
    }

    // Check if user is allowed
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      channelLogger.warn({ userId, userName }, 'Unauthorized Telegram user');
      await ctx.reply('You are not authorized to use this bot.');
      return;
    }

    // Handle /link before user-binding check — unlinked users need this command
    const content = ctx.message?.text || ctx.message?.caption || '';
    if (content.startsWith('/link')) {
      const code = await generateLinkCode({
        channelType: 'telegram',
        channelUserId: userId,
        channelUserName: userName,
      });
      await ctx.reply(
        `Your link code: *${code}*\n\n` +
        'Enter this code in the web UI at Settings → Channels within 5 minutes.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Try to find user binding (Phase 2e: scope-aware, O(1) lookup
    // on `channel_identities` with a JSONB fallback for legacy rows).
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const user = await getChannelBindingManager().findUserRecordByExternalId('telegram', userId);

    if (!user) {
      // Prompt for linking
      channelLogger.info({ userId, userName }, 'New Telegram user - needs linking');
      await ctx.reply(
        'Welcome! Please link your account:\n' +
        '1. Send /link here to get a link code\n' +
        '2. Enter the code in the web UI at Settings → Channels'
      );
      return;
    }

    const attachments = await this.extractAttachments(ctx, attachmentType);

    // Handle channel-specific commands locally; pass everything else through
    if (content.startsWith('/')) {
      const cmd = content.split(/\s+/)[0].toLowerCase();
      // /start and /link are Telegram-only commands
      if (cmd === '/start') {
        await ctx.reply('Hello! I am your AI assistant. How can I help you today?');
        return;
      }
      if (cmd === '/link') {
        await ctx.reply('Your account is already linked!');
        return;
      }
      // All other commands (/help, /status, /clear, /plan, /experts, /models, /stop)
      // flow through as regular messages to the centralized command registry
    }

    // Create and emit unified message
    const message = this.createUnifiedMessage(chatId, user.id, content, {
      userName,
      replyTo: ctx.message?.reply_to_message ? String(ctx.message.reply_to_message.message_id) : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        telegramUserId: userId,
        messageId: ctx.message?.message_id,
      },
    });

    this.emitMessage(message);
  }

  /** The photo, document or voice note of a message, as attachments to download. */
  private async extractAttachments(ctx: Context, attachmentType?: string): Promise<Attachment[]> {
    const attachments: Attachment[] = [];

    // Telegram returns `file_path` as a server-controlled string we then embed
    // into our download URL. A malicious or compromised upstream could include
    // path-traversal segments; restrict to the format Telegram actually serves.
    const safeFilePath = (fp: string | undefined): string | null => {
      if (!fp || !/^[A-Za-z0-9/_.\-]+$/.test(fp) || fp.includes('..')) return null;
      return fp;
    };

    if (attachmentType === 'photo' && ctx.message?.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution
      const file = await ctx.api.getFile(photo.file_id);
      const fp = safeFilePath(file.file_path);
      if (fp) {
        attachments.push({
          type: 'image',
          url: `https://api.telegram.org/file/bot${this.bot!.token}/${fp}`,
          mimeType: 'image/jpeg',
          size: photo.file_size,
        });
      }
    }

    if (attachmentType === 'document' && ctx.message?.document) {
      const doc = ctx.message.document;
      const file = await ctx.api.getFile(doc.file_id);
      const fp = safeFilePath(file.file_path);
      if (fp) {
        attachments.push({
          type: 'file',
          url: `https://api.telegram.org/file/bot${this.bot!.token}/${fp}`,
          mimeType: doc.mime_type || 'application/octet-stream',
          filename: doc.file_name,
          size: doc.file_size,
        });
      }
    }

    if (attachmentType === 'voice' && ctx.message?.voice) {
      const voice = ctx.message.voice;
      const file = await ctx.api.getFile(voice.file_id);
      const fp = safeFilePath(file.file_path);
      if (fp) {
        attachments.push({
          type: 'audio',
          url: `https://api.telegram.org/file/bot${this.bot!.token}/${fp}`,
          mimeType: voice.mime_type || 'audio/ogg',
          size: voice.file_size,
        });
      }
    }

    return attachments;
  }

  private async sendAttachment(chatId: number, attachment: Attachment, replyTo?: string, threadId?: string): Promise<void> {
    if (!this.bot) return;

    const options: Record<string, unknown> = {};
    if (replyTo) {
      options.reply_to_message_id = parseInt(replyTo, 10);
    }
    if (threadId && /^\d+$/.test(threadId)) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    switch (attachment.type) {
      case 'image':
        if (attachment.url) {
          await this.bot.api.sendPhoto(chatId, attachment.url, options);
        } else if (attachment.data) {
          await this.bot.api.sendPhoto(chatId, new Blob([attachment.data as BlobPart]) as any, options);
        }
        break;

      case 'file':
        if (attachment.url) {
          await this.bot.api.sendDocument(chatId, attachment.url, {
            ...options,
            caption: attachment.filename,
          });
        }
        break;

      case 'audio':
        if (attachment.url) {
          await this.bot.api.sendAudio(chatId, attachment.url, options);
        } else if (attachment.data) {
          // Voice-out: synthesized TTS arrives as raw bytes, not a URL.
          await this.bot.api.sendAudio(chatId, new InputFile(attachment.data as Uint8Array, attachment.filename), options);
        }
        break;

      case 'video':
        if (attachment.url) {
          await this.bot.api.sendVideo(chatId, attachment.url, options);
        }
        break;
    }
  }
}

export const telegramChannel = new TelegramChannel();
