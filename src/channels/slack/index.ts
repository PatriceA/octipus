import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { generateLinkCode } from '@/channels/linking';
import { getConfig } from '@/config';
import type { Config } from '@/config/schema';
import type { Attachment, ChannelResponse, ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';

interface SlackMessage {
  user: string;
  text?: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
}

interface SlackFile {
  url_private: string;
  mimetype: string;
  name: string;
  size: number;
}

interface SlackBlock {
  type: 'section' | 'image' | 'divider' | 'actions' | 'context' | 'header';
  text?: { type: 'mrkdwn' | 'plain_text'; text: string };
  image_url?: string;
  alt_text?: string;
}

type SayFn = (msg: string | { text: string; thread_ts?: string }) => Promise<unknown>;


export class SlackChannel extends BaseChannel {
  readonly type: ChannelType = 'slack';
  readonly name = 'Slack';

  private app: App | null = null;

  override isEnabled(config: Config): boolean {
    return Boolean(config.slack?.botToken);
  }

  async connect(): Promise<void> {
    const config = getConfig();

    if (!config.slack?.botToken || !config.slack?.appToken) {
      channelLogger.warn('Slack tokens not configured');
      return;
    }

    this.app = new App({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      socketMode: true,
      signingSecret: config.slack.signingSecret,
    });

    // Handle messages
    this.app.message(async ({ message, say, client }) => {
      await this.handleMessage(message as SlackMessage, say as SayFn, client);
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say, client }) => {
      await this.handleMention(event as SlackMessage, say as SayFn, client);
    });

    // Handle "link" keyword for account linking
    this.app.message(/^link$/i, async ({ message, say }) => {
      const msg = message as SlackMessage;
      const slackUserId = msg.user;

      // Check if already linked (Phase 2e: scoped O(1) lookup on
      // `channel_identities`, with JSONB fallback for legacy bindings).
      const { getChannelBindingManager } = await import('@/security/channel-bindings');
      const existing = await getChannelBindingManager().findUserRecordByExternalId('slack', slackUserId);
      if (existing) {
        await (say as SayFn)({ text: 'Your account is already linked!', thread_ts: msg.thread_ts });
        return;
      }

      let userName = slackUserId;
      try {
        const userInfo = await this.app!.client.users.info({ user: slackUserId });
        userName = userInfo.user?.real_name || userInfo.user?.name || slackUserId;
      } catch { /* ignore */ }

      const code = await generateLinkCode({
        channelType: 'slack',
        channelUserId: slackUserId,
        channelUserName: userName,
      });

      await (say as SayFn)({
        text: `Your link code: *${code}*\nEnter this code in the web UI at POST /api/auth/link within 5 minutes.`,
        thread_ts: msg.thread_ts,
      });
    });

    // Handle DMs
    this.app.event('message', async ({ event, say, client }) => {
      const msg = event as SlackMessage;
      if (msg.channel_type === 'im') {
        await this.handleMessage(msg, say as SayFn, client);
      }
    });

    try {
      await this.app.start();
      this.setConnected(true);
      channelLogger.info('Slack app started in socket mode');
    } catch (error) {
      this.emitError(error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.setConnected(false);
    }
  }

  async send(channelId: string, response: ChannelResponse): Promise<string> {
    if (!this.app) {
      throw new Error('Slack app not connected');
    }

    const _config = getConfig();

    // Build message blocks for rich formatting
    const blocks: SlackBlock[] = [];

    if (response.content) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: response.content,
        },
      });
    }

    // Add attachment blocks
    if (response.attachments?.length) {
      for (const attachment of response.attachments) {
        if (attachment.type === 'image' && attachment.url) {
          blocks.push({
            type: 'image',
            image_url: attachment.url,
            alt_text: attachment.filename || 'Image',
          });
        }
      }
    }

    const options: Record<string, unknown> = {
      channel: channelId,
      text: response.content,
      blocks: blocks.length > 0 ? blocks : undefined,
    };

    if (response.threadId) {
      options.thread_ts = response.threadId;
    }

    const result = await this.app.client.chat.postMessage(options as Parameters<WebClient['chat']['postMessage']>[0]);

    return result.ts || '';
  }

  override async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.app) return;
    // Slack reactions use short names without colons, e.g. 'white_check_mark'
    // Map common emojis to Slack reaction names
    const emojiMap: Record<string, string> = {
      '✅': 'white_check_mark', '❌': 'x', '🤔': 'thinking_face',
      '🧠': 'brain', '🔧': 'wrench', '💻': 'computer',
      '🔍': 'mag', '📖': 'book', '⏳': 'hourglass_flowing_sand',
      '🛑': 'octagonal_sign', '😐': 'neutral_face', '😬': 'grimacing',
      '🐳': 'whale', '💬': 'speech_balloon', '📄': 'page_facing_up',
    };
    const name = emojiMap[emoji] || 'eyes';
    try {
      await this.app.client.reactions.add({ channel: channelId, timestamp: messageId, name });
    } catch {
      // Silently ignore — may already have this reaction
    }
  }

  override async sendTyping(_channelId: string, _active: boolean = true): Promise<void> {
    // Slack doesn't have a direct "typing" indicator API for bots
  }

  private async handleMessage(
    message: SlackMessage,
    say: SayFn,
    client: WebClient
  ): Promise<void> {
    // Ignore bot messages
    if (message.bot_id || message.subtype === 'bot_message') {
      return;
    }

    const slackUserId = message.user;
    const channelId = message.channel;
    const threadTs = message.thread_ts;

    // Get user info
    let userName = slackUserId;
    try {
      const userInfo = await client.users.info({ user: slackUserId });
      userName = userInfo.user?.real_name || userInfo.user?.name || slackUserId;
    } catch {
      // Ignore errors getting user info
    }

    // Find user binding (Phase 2e: scoped O(1) lookup).
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const user = await getChannelBindingManager().findUserRecordByExternalId('slack', slackUserId);

    if (!user) {
      channelLogger.info({ slackUserId, userName }, 'New Slack user - needs linking');
      await say({
        text: 'Welcome! Type `link` to get a link code, then enter it in the web UI to connect your account.',
        thread_ts: threadTs,
      });
      return;
    }

    // Extract attachments
    const attachments: Attachment[] = [];

    if (message.files) {
      for (const file of message.files) {
        attachments.push({
          type: this.mapFileType(file.mimetype),
          url: file.url_private,
          mimeType: file.mimetype,
          filename: file.name,
          size: file.size,
        });
      }
    }

    // Create unified message
    const unifiedMessage = this.createUnifiedMessage(channelId, user.id, message.text || '', {
      userName,
      threadId: threadTs,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        slackUserId,
        ts: message.ts,
        channelType: message.channel_type,
      },
    });

    this.emitMessage(unifiedMessage);
  }

  private async handleMention(event: SlackMessage, say: SayFn, client: WebClient): Promise<void> {
    // Remove the bot mention from the text
    const text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();

    // Create a synthetic message event
    await this.handleMessage(
      {
        ...event,
        text,
      },
      say,
      client
    );
  }

  private mapFileType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
  }
}

export const slackChannel = new SlackChannel();
