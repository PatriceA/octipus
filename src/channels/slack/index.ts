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

    // Contain listener errors. Without a global error handler, an error thrown
    // while Bolt processes an event (e.g. invalid_auth on a stale bot token)
    // surfaces as an unhandled error — which during this project wedged the
    // whole backend. Log it (fail-loud) and keep the channel alive.
    this.app.error(async (error) => {
      channelLogger.error({ err: error, channel: 'slack' }, 'Slack Bolt error (contained)');
    });

    // ONE message listener. Bolt invokes EVERY matching listener for an event,
    // so the old setup (a catch-all `app.message()` PLUS `app.event('message')`
    // for DMs PLUS a separate `app.event('app_mention')`) fired handleMessage
    // two or three times for a single message → duplicate root agent runs and
    // duplicate replies. `app.message()` already receives message events across
    // every channel type the bot can see (DMs, channels, groups), so it is the
    // single entry point; mentions in joined channels arrive as message events
    // too, so `app_mention` is redundant.
    this.app.message(async ({ message, say, client }) => {
      const msg = message as SlackMessage;
      if (msg.bot_id || msg.subtype === 'bot_message') return; // ignore the bot's own posts
      // Strip a leading bot @mention so "@octipus hi" reads as "hi".
      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>/gi, '').trim();
      // `link` keyword shortcut (the `/link` slash command does the same).
      if (/^link$/i.test(text)) {
        await (say as SayFn)({ text: await this.linkReplyText(msg.user), thread_ts: msg.thread_ts });
        return;
      }
      await this.handleMessage({ ...msg, text }, say as SayFn, client);
    });

    // `/link` slash command — Slack intercepts messages starting with `/`, so a
    // user who types `/link` never reaches the message listener above. Delivered
    // over Socket Mode (no Request URL). Requires the `commands` scope.
    this.app.command('/link', async ({ command, ack, respond }) => {
      await ack(); // Slack requires an ack within 3s
      await respond({ text: await this.linkReplyText(command.user_id), response_type: 'ephemeral' });
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

    const result = await this.app.client.chat.postMessage(options as unknown as Parameters<WebClient['chat']['postMessage']>[0]);

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

  /** Build the reply for a link request: a fresh code, or an already-linked notice. */
  private async linkReplyText(slackUserId: string): Promise<string> {
    // Scoped O(1) lookup on `channel_identities`, JSONB fallback for legacy rows.
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const existing = await getChannelBindingManager().findUserRecordByExternalId('slack', slackUserId);
    if (existing) return 'Your account is already linked!';

    let userName = slackUserId;
    try {
      const userInfo = await this.app!.client.users.info({ user: slackUserId });
      userName = userInfo.user?.real_name || userInfo.user?.name || slackUserId;
    } catch { /* ignore */ }

    const code = await generateLinkCode({ channelType: 'slack', channelUserId: slackUserId, channelUserName: userName });
    return `Your link code: *${code}*\nEnter it at Settings → Channels within 5 minutes.`;
  }

  private mapFileType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
  }
}

export const slackChannel = new SlackChannel();
