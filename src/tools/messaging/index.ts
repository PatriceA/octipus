import { createHash } from 'crypto';
import { getUMI } from '@/channels/interface';
import type { ChannelMessage } from '@/core/channels/messages';
import type { AgentContext, ToolManifest } from '@/core/types';
import { BaseTool, createParameterSchema } from '../base-tool';

// In-process dedup so a fan-out of sibling agents doesn't ping the user N times
// with the same text. Keyed by target+content, short TTL. Per-process — fine for
// single-node; a shared store would be needed to dedup across nodes.
// ponytail: 60s window, in-memory Map; swap for a shared cache if multi-node.
const RECENT_SENDS = new Map<string, number>(); // key -> expiresAt (epoch ms)
const SEND_DEDUP_WINDOW_MS = 60_000;
function recentlySent(key: string): boolean {
  const now = Date.now();
  for (const [k, exp] of RECENT_SENDS) if (exp <= now) RECENT_SENDS.delete(k);
  return (RECENT_SENDS.get(key) ?? 0) > now;
}
// Record a send only AFTER it succeeds — marking on the mere attempt would let a
// transient send failure poison the key and silently suppress the retry.
function markSent(key: string): void {
  RECENT_SENDS.set(key, Date.now() + SEND_DEDUP_WINDOW_MS);
}
function contentHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export class MessagingTool extends BaseTool {
  readonly id = 'messaging';
  readonly name = 'Cross-Channel Messaging';
  readonly version = '1.1.0';
  readonly description = 'Send messages across channels (Telegram, Slack, Teams, WhatsApp, WebChat), read and search channel history, list channels, and look up user contacts.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'send', description: 'Send messages to connected channels on behalf of the user', defaultLevel: 'ASK' },
        { action: 'list', description: 'List connected channels and user contacts', defaultLevel: 'ALLOW' },
        { action: 'read', description: 'Read and search the history of channels the account can already see', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'send_message', description: 'Send a message to a specific channel + target', parameters: { channel: { type: 'string', description: 'Channel type', required: true }, target: { type: 'string', description: 'Target ID', required: true }, message: { type: 'string', description: 'Message content', required: true } }, returns: 'Delivery confirmation' },
        { name: 'send_to_user', description: 'Send a message to a user on their linked channels', parameters: { user_id: { type: 'string', description: 'User ID', required: true }, message: { type: 'string', description: 'Message content', required: true } }, returns: 'Per-channel delivery results' },
        { name: 'list_channels', description: 'List connected messaging channels', parameters: {}, returns: 'Channel list with status' },
        { name: 'list_contacts', description: 'List users with their linked channel accounts', parameters: {}, returns: 'User contact list' },
        { name: 'channel_history', description: 'Read recent messages from a channel or chat', parameters: { channel: { type: 'string', description: 'slack or teams', required: true }, target: { type: 'string', description: 'Channel name or id', required: true } }, returns: 'Messages, newest first' },
        { name: 'channel_search', description: 'Search messages across channels', parameters: { channel: { type: 'string', description: 'slack or teams', required: true }, query: { type: 'string', description: 'Search terms', required: true } }, returns: 'Matching messages' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'send_message',
      'Send a message to a specific channel and target ID. Use list_channels to see available channels and list_contacts to find user IDs.',
      createParameterSchema({
        channel: { type: 'string', description: 'Channel type: telegram, slack, teams, whatsapp, or webchat', required: true },
        target: { type: 'string', description: 'Target channel/chat/user ID', required: true },
        message: { type: 'string', description: 'Message content to send', required: true },
        reply_to: { type: 'string', description: 'Thread or message ID to reply to (optional)' },
      }),
      async (args) => {
        const umi = getUMI();
        const channel = args.channel as string;
        const target = args.target as string;

        if (!umi.isChannelAvailable(channel as any)) {
          return { success: false, error: `Channel ${channel} is not connected` };
        }

        const dedupKey = `msg ${channel} ${target} ${contentHash(args.message as string)}`;
        if (recentlySent(dedupKey)) {
          return { success: true, deduped: true, channel, target, note: 'Identical message already sent to this target moments ago — suppressed to avoid duplicate notifications.' };
        }

        try {
          const messageId = await umi.send(channel as any, target, {
            content: args.message as string,
          });
          markSent(dedupKey);
          return { success: true, messageId, channel, target };
        } catch (err) {
          return { success: false, error: (err as Error).message };
        }
      },
    );

    this.registerTool(
      'send_to_user',
      'Send a message to a user on their linked channels. Looks up the user\'s verified channel bindings and sends to all (or a specific channel).',
      createParameterSchema({
        user_id: { type: 'string', description: 'User ID to send to', required: true },
        message: { type: 'string', description: 'Message content', required: true },
        channel: { type: 'string', description: 'Specific channel to use (optional — sends to all verified channels if omitted)' },
      }),
      async (args) => {
        const { userRepository } = await import('@/db/repositories/user-repository');
        const user = await userRepository.findById(args.user_id as string);
        if (!user) return { success: false, error: 'User not found' };

        let rawBindings = user.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
        if (typeof rawBindings === 'string') {
          try { rawBindings = JSON.parse(rawBindings); } catch { rawBindings = []; }
        }
        const bindings = (rawBindings as import('@/db/schema/users').ChannelBinding[]) || [];
        const verified = bindings.filter(b => b.isVerified);

        if (verified.length === 0) {
          return { success: false, error: 'User has no verified channel bindings' };
        }

        const targetChannel = args.channel as string | undefined;
        const targets = targetChannel
          ? verified.filter(b => b.channelType === targetChannel)
          : verified;

        if (targets.length === 0) {
          return { success: false, error: `User has no verified binding for channel: ${targetChannel}` };
        }

        const dedupKey = `user ${args.user_id} ${targetChannel ?? 'all'} ${contentHash(args.message as string)}`;
        if (recentlySent(dedupKey)) {
          return { success: true, deduped: true, note: 'Identical message already sent to this user moments ago — suppressed to avoid duplicate notifications.' };
        }

        const umi = getUMI();
        const results: { channel: string; success: boolean; error?: string }[] = [];

        for (const binding of targets) {
          try {
            if (!umi.isChannelAvailable(binding.channelType as any)) {
              results.push({ channel: binding.channelType, success: false, error: 'Channel not connected' });
              continue;
            }
            await umi.send(binding.channelType as any, binding.channelUserId, {
              content: args.message as string,
            });
            results.push({ channel: binding.channelType, success: true });
          } catch (err) {
            results.push({ channel: binding.channelType, success: false, error: (err as Error).message });
          }
        }

        if (results.some(r => r.success)) markSent(dedupKey); // only after ≥1 channel delivered
        return { success: results.some(r => r.success), results };
      },
    );

    this.registerTool(
      'list_channels',
      'List all registered messaging channels and their connection status.',
      createParameterSchema({}),
      async () => {
        const umi = getUMI();
        const channels = umi.getAllChannels();
        return {
          channels: channels.map(ch => ({
            type: ch.type,
            name: ch.name,
            connected: ch.isConnected(),
          })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'list_contacts',
      'List users who have linked channel accounts. Shows which channels each user can be reached on.',
      createParameterSchema({}),
      async () => {
        const { userRepository } = await import('@/db/repositories/user-repository');
        const users = await userRepository.listAll();

        const contacts = users
          .filter(u => {
            let bindings = u.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
            if (typeof bindings === 'string') {
              try { bindings = JSON.parse(bindings); } catch { return false; }
            }
            return Array.isArray(bindings) && bindings.some(b => b.isVerified);
          })
          .map(u => {
            let bindings = u.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
            if (typeof bindings === 'string') {
              try { bindings = JSON.parse(bindings); } catch { bindings = []; }
            }
            const verified = (bindings as import('@/db/schema/users').ChannelBinding[]).filter(b => b.isVerified);
            return {
              userId: u.id,
              displayName: u.username || u.id,
              channels: verified.map(b => ({
                type: b.channelType,
                channelUserId: b.channelUserId,
                channelUserName: b.channelUserName,
              })),
            };
          });

        return { contacts };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'channel_history',
      'Read recent messages from a Slack channel or a Microsoft Teams channel or chat — this is how you answer "what did the team decide yesterday". Slack: `target` is the channel name (with or without the #) or its id, and the bot must be in the channel. Teams: `target` is "Team/Channel" (e.g. "Engineering/General") or a chat id, and it reads as the signed-in user, so you see exactly what they can see. Pass `thread` with a message id to read one thread instead of the channel.',
      createParameterSchema({
        channel: { type: 'string', description: 'slack or teams', required: true, enum: ['slack', 'teams'] },
        target: { type: 'string', description: 'Slack: channel name or id. Teams: "Team/Channel" or a chat id.', required: true },
        limit: { type: 'number', description: 'Maximum messages to return (default 50, max 200)', default: 50 },
        after: { type: 'string', description: 'Only messages at or after this ISO-8601 time' },
        before: { type: 'string', description: 'Only messages at or before this ISO-8601 time' },
        thread: { type: 'string', description: 'Read the replies to this message id instead of the channel' },
      }),
      async (args, context) => this.readHistory(args, context),
      { permissionAction: 'read' },
    );

    this.registerTool(
      'channel_search',
      'Search messages. Teams searches everything the signed-in user can see. Slack needs either a configured user token (Slack does not let bots search) or a `target` channel to scan — without one of those it will tell you so rather than return nothing.',
      createParameterSchema({
        channel: { type: 'string', description: 'slack or teams', required: true, enum: ['slack', 'teams'] },
        query: { type: 'string', description: 'Search terms. Quote a phrase to match it whole.', required: true },
        target: { type: 'string', description: 'Restrict to one channel (Slack: required when no user token is configured)' },
        limit: { type: 'number', description: 'Maximum messages to return (default 25, max 100)', default: 25 },
        after: { type: 'string', description: 'Only messages at or after this ISO-8601 time' },
      }),
      async (args, context) => this.searchMessages(args, context),
      { permissionAction: 'read' },
    );
  }

  /** Transcripts are quoted into a prompt, so they get a hard character budget. */
  private static readonly MAX_TRANSCRIPT_CHARS = 40_000;

  private async readHistory(args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
    const channel = String(args.channel ?? '').toLowerCase();
    const target = String(args.target ?? '');
    const limit = clampCount(args.limit, 50, 200);

    try {
      if (channel === 'slack') {
        const { slackBotClient } = await import('@/core/channels/read-clients');
        const client = await slackBotClient();
        if (!client) {
          return { error: 'Slack is not connected. Configure the bot token on the Channels settings page.' };
        }
        const { readSlackHistory } = await import('@/core/channels/slack-read');
        const result = await readSlackHistory(client, {
          target,
          limit,
          after: optionalString(args.after),
          before: optionalString(args.before),
          thread: optionalString(args.thread),
        });
        return this.transcript('slack', result.conversation.id, result.conversation.name, result.messages, result.hasMore);
      }

      if (channel === 'teams') {
        if (!context.userId) {
          return { error: 'Reading Teams needs a signed-in user — it reads as that user, not as the bot.' };
        }
        const { teamsGraphClient } = await import('@/core/channels/read-clients');
        const graph = await teamsGraphClient(context.userId);
        if (!graph) {
          return { error: 'Microsoft 365 is not connected for this user. Connect the Microsoft account in Settings > Integrations.' };
        }
        const { readTeamsHistory } = await import('@/core/channels/teams-read');
        const result = await readTeamsHistory(graph, {
          target,
          limit,
          after: optionalString(args.after),
          before: optionalString(args.before),
          thread: optionalString(args.thread),
        });
        const name = result.conversation.teamName && result.conversation.name
          ? `${result.conversation.teamName}/${result.conversation.name}`
          : result.conversation.name;
        return this.transcript('teams', result.conversation.id, name, result.messages, result.hasMore);
      }

      return { error: `channel_history supports slack and teams, not "${channel}"` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  private async searchMessages(args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
    const channel = String(args.channel ?? '').toLowerCase();
    const query = String(args.query ?? '').trim();
    const limit = clampCount(args.limit, 25, 100);
    const target = optionalString(args.target);
    const after = optionalString(args.after);

    if (query.length === 0) return { error: 'query is empty' };

    try {
      if (channel === 'slack') {
        const { slackBotClient, slackUserClient } = await import('@/core/channels/read-clients');
        const { matchesQuery } = await import('@/core/channels/messages');

        const userClient = await slackUserClient();
        if (userClient) {
          const { searchSlackMessages } = await import('@/core/channels/slack-read');
          const messages = await searchSlackMessages(userClient, { query, limit, target, after });
          return { channel: 'slack', method: 'search', query, messages, count: messages.length };
        }

        // No user token: Slack's search API is closed to us. Scanning one
        // channel is a real answer with a stated limit, which beats both a
        // silent empty result and a bare "not supported".
        if (!target) {
          return {
            error: 'Slack does not allow bots to search. Either set a Slack user token (xoxp-) on the Channels settings page, or pass `target` to scan one channel\'s recent history.',
          };
        }
        const botClient = await slackBotClient();
        if (!botClient) {
          return { error: 'Slack is not connected. Configure the bot token on the Channels settings page.' };
        }
        const { readSlackHistory } = await import('@/core/channels/slack-read');
        const SCAN_DEPTH = 500;
        const scanned = await readSlackHistory(botClient, { target, limit: SCAN_DEPTH, after });
        const messages = scanned.messages.filter((m) => matchesQuery(m, query)).slice(0, limit);
        return {
          channel: 'slack',
          method: 'scan',
          query,
          scannedMessages: scanned.messages.length,
          scanLimitReached: scanned.hasMore,
          messages,
          count: messages.length,
        };
      }

      if (channel === 'teams') {
        if (!context.userId) {
          return { error: 'Searching Teams needs a signed-in user — it searches as that user.' };
        }
        const { teamsGraphClient } = await import('@/core/channels/read-clients');
        const graph = await teamsGraphClient(context.userId);
        if (!graph) {
          return { error: 'Microsoft 365 is not connected for this user. Connect the Microsoft account in Settings > Integrations.' };
        }
        const { searchTeamsMessages } = await import('@/core/channels/teams-read');
        let messages = await searchTeamsMessages(graph, { query, limit });
        if (after) messages = messages.filter((m) => m.at >= after);
        if (target) {
          messages = messages.filter((m) => m.conversationId === target || m.conversationName === target);
        }
        return { channel: 'teams', method: 'search', query, messages, count: messages.length };
      }

      return { error: `channel_search supports slack and teams, not "${channel}"` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  private async transcript(
    channel: 'slack' | 'teams',
    conversationId: string,
    conversationName: string | undefined,
    messages: ChannelMessage[],
    hasMore: boolean,
  ): Promise<unknown> {
    const { capMessages, sortNewestFirst } = await import('@/core/channels/messages');
    const ordered = sortNewestFirst(messages);
    const kept = capMessages(ordered, MessagingTool.MAX_TRANSCRIPT_CHARS);
    return {
      channel,
      conversationId,
      conversationName,
      messages: kept,
      count: kept.length,
      truncated: kept.length < ordered.length,
      hasMore,
    };
  }
}

/** Clamp a model-supplied count to something the platform will accept. */
function clampCount(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

export const messagingTool = new MessagingTool();
