import { Bot, type Context } from 'grammy';
import { BaseChannel } from '../interface';
import { getConfig } from '@/config';
import { userRepository } from '@/db/repositories/user-repository';
import { generateLinkCode } from '@/channels/linking';
import { channelLogger } from '@/utils/logger';
import type { ChannelType, ChannelResponse, Attachment } from '@/core/types';

export class TelegramChannel extends BaseChannel {
  readonly type: ChannelType = 'telegram';
  readonly name = 'Telegram';

  private bot: Bot | null = null;
  private allowedUsers: Set<string> = new Set();

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

    // Error handling
    this.bot.catch((err) => {
      this.emitError(err.error as Error);
    });

    // Start the bot
    try {
      // Use polling
      this.bot.start({
        onStart: (botInfo) => {
          channelLogger.info({ username: botInfo.username }, 'Telegram bot started');
          this.setConnected(true);
        },
      });
    } catch (error) {
      this.emitError(error as Error);
      throw error;
    }
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
        await this.sendAttachment(chatId, attachment, response.replyTo);
      }
    }

    // Send text message — split into chunks if over Telegram's 4096 char limit
    const MAX_LEN = 4096;
    const chunks = this.splitMessage(response.content, MAX_LEN);
    let lastMessageId = '';

    for (let i = 0; i < chunks.length; i++) {
      const options: Record<string, unknown> = {
        parse_mode: 'Markdown',
      };

      // Only set reply-to on the first chunk
      if (i === 0 && response.replyTo) {
        options.reply_to_message_id = parseInt(response.replyTo, 10);
      }

      try {
        const result = await this.bot.api.sendMessage(chatId, chunks[i], options);
        lastMessageId = String(result.message_id);
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
        } else {
          throw err;
        }
      }
    }

    return lastMessageId;
  }

  private async handleMessage(ctx: Context, attachmentType?: string): Promise<void> {
    const userId = String(ctx.from?.id);
    const chatId = String(ctx.chat?.id);
    const userName = ctx.from?.username || ctx.from?.first_name;

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

    // Try to find user binding
    const user = await userRepository.findByChannelBinding('telegram', userId);

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

    // Extract attachments
    const attachments: Attachment[] = [];

    if (attachmentType === 'photo' && ctx.message?.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution
      const file = await ctx.api.getFile(photo.file_id);

      attachments.push({
        type: 'image',
        url: `https://api.telegram.org/file/bot${this.bot!.token}/${file.file_path}`,
        mimeType: 'image/jpeg',
        size: photo.file_size,
      });
    }

    if (attachmentType === 'document' && ctx.message?.document) {
      const doc = ctx.message.document;
      const file = await ctx.api.getFile(doc.file_id);

      attachments.push({
        type: 'file',
        url: `https://api.telegram.org/file/bot${this.bot!.token}/${file.file_path}`,
        mimeType: doc.mime_type || 'application/octet-stream',
        filename: doc.file_name,
        size: doc.file_size,
      });
    }

    if (attachmentType === 'voice' && ctx.message?.voice) {
      const voice = ctx.message.voice;
      const file = await ctx.api.getFile(voice.file_id);

      attachments.push({
        type: 'audio',
        url: `https://api.telegram.org/file/bot${this.bot!.token}/${file.file_path}`,
        mimeType: voice.mime_type || 'audio/ogg',
        size: voice.file_size,
      });
    }

    // Handle commands
    if (content.startsWith('/')) {
      await this.handleCommand(ctx, content, user.id);
      return;
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

  private async handleCommand(ctx: Context, command: string, userId: string): Promise<void> {
    const cmd = command.split(' ')[0].toLowerCase();

    switch (cmd) {
      case '/start':
        await ctx.reply('Hello! I am your AI assistant. How can I help you today?');
        break;

      case '/help':
        await ctx.reply(
          'Available commands:\n' +
          '/start - Start conversation\n' +
          '/help - Show this help\n' +
          '/link - Get a code to link your account\n' +
          '/status - Check bot status\n' +
          '/clear - Clear conversation history'
        );
        break;

      case '/status':
        await ctx.reply('Bot is online and ready to assist you.');
        break;

      case '/link':
        // Handled before user-binding check in handleMessage()
        // This branch is for already-linked users who want a new code
        await ctx.reply('Your account is already linked!');
        break;

      case '/clear':
        // This would need to clear the session
        await ctx.reply('Conversation history cleared.');
        break;

      default:
        await ctx.reply(`Unknown command: ${cmd}`);
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = -1;

      // Try splitting at paragraph boundary (double newline)
      const paragraphEnd = remaining.lastIndexOf('\n\n', maxLen);
      if (paragraphEnd > maxLen * 0.3) {
        splitAt = paragraphEnd + 2; // include the double newline
      }

      // Try splitting at single newline
      if (splitAt === -1) {
        const lineEnd = remaining.lastIndexOf('\n', maxLen);
        if (lineEnd > maxLen * 0.3) {
          splitAt = lineEnd + 1;
        }
      }

      // Last resort: split at maxLen
      if (splitAt === -1) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }

    return chunks;
  }

  private async sendAttachment(chatId: number, attachment: Attachment, replyTo?: string): Promise<void> {
    if (!this.bot) return;

    const options: Record<string, unknown> = {};
    if (replyTo) {
      options.reply_to_message_id = parseInt(replyTo, 10);
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
