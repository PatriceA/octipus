import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { generateLinkCode } from '@/channels/linking';
import { getConfig } from '@/config';
import type { Config } from '@/config/schema';
import type { Attachment, ChannelResponse, ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';
import { shouldSendHint } from '../hint-limiter';
import { type GroupMember, handleSlackGroupMessage, handleSlackGroupReaction, type SlackGroupDeps, type SlackReaction } from './group';

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
  /** DM channel id → the Slack user it is with (see dmUser). */
  private dmUsers = new Map<string, string>();
  /** The bot's own user and bot ids (`auth.test`), for mention detection in channels. */
  private botUserId: string | null = null;
  private botId: string | null = null;

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
      // Channels, private channels and group DMs follow the group-channel rules:
      // silent unless enrolled and addressed. Only 1:1 DMs take the path below.
      if (msg.channel_type && msg.channel_type !== 'im') {
        try {
          await handleSlackGroupMessage(msg, this.groupDeps(client));
        } catch (err) {
          channelLogger.error({ err, channel: msg.channel }, 'Slack group message handling failed');
        }
        return;
      }
      // Strip a leading bot @mention so "@octipus hi" reads as "hi".
      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>/gi, '').trim();
      // `link` keyword shortcut (the `/link` slash command does the same).
      if (/^link$/i.test(text)) {
        await (say as SayFn)({ text: await this.linkReplyText(msg.user), thread_ts: msg.thread_ts });
        return;
      }
      await this.handleMessage({ ...msg, text }, say as SayFn, client);
    });

    // 🐙 on a message in an enrolled channel takes it on as a task (group
    // channels, phase 2). Needs the `reactions:read` scope and the
    // `reaction_added` bot event; without them this never fires.
    this.app.event('reaction_added', async ({ event, client }) => {
      try {
        await handleSlackGroupReaction(event as SlackReaction, this.groupDeps(client));
      } catch (err) {
        channelLogger.error({ err }, 'Slack group reaction handling failed');
      }
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
      await this.loadBotIdentity();
    } catch (error) {
      this.emitError(error as Error);
      throw error;
    }
  }

  /**
   * Learn the bot's own ids. Without them no channel message counts as a
   * mention, so group channels stay silent — say so loudly.
   */
  private async loadBotIdentity(): Promise<void> {
    if (!this.app) return;
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = (auth.user_id as string | undefined) ?? null;
      this.botId = (auth.bot_id as string | undefined) ?? null;
      if (!this.botUserId) channelLogger.error('Slack auth.test returned no user_id — group channels will not respond to mentions');
    } catch (err) {
      channelLogger.error({ err }, 'Slack auth.test failed — group channels will not respond to mentions');
    }
  }

  /** Platform calls for `handleSlackGroupMessage`. */
  private groupDeps(client: WebClient): SlackGroupDeps {
    const logFailure = (what: string) => (err: unknown) => {
      channelLogger.error({ err }, `Slack group: ${what} failed`);
    };
    return {
      botUserId: this.botUserId,
      findGroup: async (channelId) => {
        const { findGroupChannel } = await import('@/channels/group-channels');
        return findGroupChannel('slack', channelId);
      },
      isGroupActive: async (group) => {
        const { isGroupChannelActive } = await import('@/channels/group-channels');
        return isGroupChannelActive(group);
      },
      isThreadActive: async (groupId, threadTs) => {
        const { isGroupThreadActive } = await import('@/channels/group-channels');
        return isGroupThreadActive(groupId, threadTs);
      },
      findMember: async (slackUserId): Promise<GroupMember | null> => {
        const { getChannelBindingManager } = await import('@/security/channel-bindings');
        const user = await getChannelBindingManager().findUserRecordByExternalId('slack', slackUserId);
        return user ? { id: user.id, username: user.username, isActive: user.isActive, isAdmin: user.isAdmin } : null;
      },
      join: async ({ channelId, label, userId }) => {
        const { joinGroupChannel } = await import('@/channels/group-channels');
        return joinGroupChannel({ channelType: 'slack', channelId, label, userId });
      },
      leave: async ({ channelId, userId, isAdmin }) => {
        const { leaveGroupChannel } = await import('@/channels/group-channels');
        return leaveGroupChannel({ channelType: 'slack', channelId, userId, isAdmin });
      },
      channelLabel: async (channelId) => {
        try {
          const info = await client.conversations.info({ channel: channelId });
          const name = (info.channel as { name?: string } | undefined)?.name;
          return name ? `#${name}` : null;
        } catch (err) {
          // Needs channels:read / groups:read; the label is cosmetic.
          channelLogger.debug({ err, channelId }, 'Slack conversations.info failed — enrolling without a label');
          return null;
        }
      },
      displayName: async (slackUserId) => {
        try {
          const info = await client.users.info({ user: slackUserId });
          return info.user?.real_name || info.user?.name || slackUserId;
        } catch (err) {
          channelLogger.debug({ err, slackUserId }, 'Slack users.info failed — using the raw id');
          return slackUserId;
        }
      },
      postEphemeral: async (channelId, slackUserId, text, threadTs) => {
        await client.chat.postEphemeral({ channel: channelId, user: slackUserId, text, thread_ts: threadTs })
          .catch(logFailure('chat.postEphemeral'));
      },
      postInThread: async (channelId, threadTs, text) => {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text })
          .catch(logFailure('chat.postMessage'));
      },
      readContext: (input) => this.readGroupContext(input),
      readMessage: async (channelId, ts) => {
        try {
          // Works for a top-level message and for a reply (Slack returns the
          // thread from its parent); the parent may come first, so find it by ts.
          const res = await client.conversations.replies({ channel: channelId, ts, oldest: ts, inclusive: true, limit: 2 });
          const m = (res.messages ?? []).find((x) => x.ts === ts);
          if (!m) return null;
          return {
            text: m.text ?? '',
            user: m.user ?? null,
            botId: m.bot_id ?? null,
            threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
          };
        } catch (err) {
          channelLogger.warn({ err, channelId, ts }, 'Slack conversations.replies failed — cannot read the message');
          return null;
        }
      },
      permalink: async (channelId, ts) => {
        try {
          return (await client.chat.getPermalink({ channel: channelId, message_ts: ts })).permalink ?? undefined;
        } catch (err) {
          channelLogger.debug({ err, channelId, ts }, 'Slack chat.getPermalink failed — the task has no link back');
          return undefined;
        }
      },
      budgetPause: async (group) => {
        const { groupChannelPause } = await import('@/security/spend-budgets');
        return groupChannelPause(group.id).catch((err: unknown) => {
          // Not blocking: checkSpend still refuses each run once the budget is spent.
          channelLogger.warn({ err, groupId: group.id }, 'Group channel budget check failed — not pausing');
          return null;
        });
      },
      shouldSendHint,
      dispatch: ({ channelId, member, userName, text, threadTs, group, context, message, take }) => {
        const msg = message as SlackMessage;
        const attachments = (msg.files ?? []).map((file): Attachment => ({
          type: this.mapFileType(file.mimetype),
          url: file.url_private,
          mimeType: file.mimetype,
          filename: file.name,
          size: file.size,
        }));
        this.emitMessage(this.createUnifiedMessage(channelId, member.id, text, {
          userName,
          threadId: threadTs,
          attachments: attachments.length > 0 ? attachments : undefined,
          metadata: {
            slackUserId: msg.user,
            ts: msg.ts,
            // The platform message id the dispatcher's reactions (👀, ⏳, ✅) go on.
            messageId: msg.ts,
            channelType: msg.channel_type,
            groupChannelId: group.id,
            groupContext: context,
            ...(take ? { take } : {}),
          },
        }));
      },
    };
  }

  /** The thread (or the channel's latest messages) as a transcript for the turn. */
  private async readGroupContext(input: { channelId: string; ts: string; threadTs?: string; label: string | null }): Promise<string> {
    if (!this.app) return '';
    const { readSlackHistory } = await import('@/core/channels/slack-read');
    const { slackBotClient } = await import('@/core/channels/read-clients');
    const { renderGroupContext } = await import('@/core/channels/group-context');
    const reader = await slackBotClient();
    if (!reader) return '';
    try {
      const { messages } = await readSlackHistory(reader, input.threadTs
        ? { target: input.channelId, limit: 40, thread: input.threadTs }
        : { target: input.channelId, limit: 15 });
      const botIds = new Set([this.botUserId, this.botId].filter((id): id is string => !!id));
      return renderGroupContext(messages, {
        currentMessageId: input.ts,
        botIds,
        conversationName: input.label ?? undefined,
        scope: input.threadTs ? 'thread' : 'channel',
      });
    } catch (err) {
      // Answering without the transcript beats not answering; the gap is logged.
      channelLogger.warn({ err, channelId: input.channelId }, 'Slack group: reading channel context failed — answering without it');
      return '';
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

  /** An ephemeral message to the Slack identities linked to `userId` (only they see it). */
  override async sendPrivate(channelId: string, userId: string, response: ChannelResponse): Promise<boolean> {
    if (!this.app) return false;
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const identities = (await getChannelBindingManager().listForUser(userId))
      .filter(i => i.channelType === 'slack' && i.verifiedAt);
    let delivered = false;
    for (const identity of identities) {
      try {
        await this.app.client.chat.postEphemeral({
          channel: channelId,
          user: identity.externalId,
          text: response.content,
          thread_ts: response.threadId,
        });
        delivered = true;
      } catch (err) {
        // Not in this channel, or a stale identity: try the next one.
        channelLogger.warn({ err, channelId }, 'Slack ephemeral message failed for one identity');
      }
    }
    return delivered;
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

    if (message.channel_type === 'im' && slackUserId) this.dmUsers.set(channelId, slackUserId);

    // Create unified message
    const unifiedMessage = this.createUnifiedMessage(channelId, user.id, message.text || '', {
      userName,
      threadId: threadTs,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        slackUserId,
        ts: message.ts,
        // The platform message id the dispatcher's reactions (👀, ⏳, ✅) go on.
        messageId: message.ts,
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

  /**
   * The connected bot's Web API client, or null when Slack is not running.
   *
   * The channel is otherwise write-only — it posts replies and reacts. The
   * read tools (`messaging.channel_history` / `channel_search`) need the same
   * authenticated client to call `conversations.history`, and building a
   * second one from config would double the places a rotated token has to
   * reach. Mirrors `TeamsChannel.getAdapter()`.
   */
  getWebClient(): WebClient | null {
    return this.app?.client ?? null;
  }

  /**
   * The Slack user a direct-message channel (`D…`) is with, or null for any
   * other conversation. Learned from inbound DMs, else asked of Slack
   * (`conversations.info`), so it survives a restart.
   */
  async dmUser(channelId: string): Promise<string | null> {
    const known = this.dmUsers.get(channelId);
    if (known) return known;
    const client = this.getWebClient();
    if (!client) return null;
    try {
      const info = await client.conversations.info({ channel: channelId });
      const ch = info.channel as { is_im?: boolean; user?: string } | undefined;
      if (ch?.is_im && ch.user) {
        this.dmUsers.set(channelId, ch.user);
        return ch.user;
      }
    } catch (err) {
      channelLogger.debug({ err, channelId }, 'Slack conversations.info failed');
    }
    return null;
  }
}

export const slackChannel = new SlackChannel();
