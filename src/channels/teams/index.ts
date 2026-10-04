import {
  type Activity,
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  MessageFactory,
  type TurnContext,
} from 'botbuilder';
import { generateLinkCode } from '@/channels/linking';
import { BUFFER_BOT_ID, findGroupMessageAnywhere, forgetGroupChat, groupMessages, recordGroupMessage } from '@/channels/group-buffer';
import {
  type GroupDeps, type GroupMember, groupHints, handleGroupFeedback, handleGroupMessage, MAIN_THREAD,
} from '@/channels/group-handler';
import { shouldSendHint } from '@/channels/hint-limiter';
import { getConfig } from '@/config';
import type { Config } from '@/config/schema';
import type { Attachment, ChannelResponse, ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';
import {
  conversationKind, splitConversationId, type TeamsActivityLike, teamsUserKey, threadConversationId, toGroupInbound,
} from './group';

/** Teams reactions on the bot's replies recorded as feedback. */
const TEAMS_FEEDBACK: Readonly<Record<string, 1 | -1>> = { like: 1, heart: 1, sad: -1, angry: -1 };

const HINTS = groupHints({
  platform: 'Teams',
  linkHow: 'send me `link` in a 1:1 chat',
  takeAlso: 'or reply in a thread with `@Octipus take this` to take its first message',
  followHow: 'I reply in the thread (in a group chat, mention me each time)',
});

/** Who a Teams user is, as last seen: enough to open a 1:1 chat with them. */
interface KnownAccount {
  account: { id: string; name?: string; aadObjectId?: string };
  serviceUrl: string;
  tenantId?: string;
}

const CONVREF_PREFIX = 'teams:convref:';

export class TeamsChannel extends BaseChannel {
  readonly type: ChannelType = 'teams';
  readonly name = 'Microsoft Teams';

  private adapter: CloudAdapter | null = null;
  private conversationReferences: Map<string, Partial<Activity>> = new Map();
  private referencesLoaded: Promise<number> | null = null;
  /** Enrolled group conversations (base ids) seen since start: the bot's replies there join the transcript. */
  private groupConversations = new Set<string>();
  /** Teams users seen in group chats, by `teamsUserKey`: their names, and how to reach them privately. */
  private accounts = new Map<string, KnownAccount>();

  override isEnabled(config: Config): boolean {
    return Boolean(config.teams?.appId);
  }

  async connect(): Promise<void> {
    const config = getConfig();

    if (!config.teams?.appId || !config.teams?.appPassword) {
      channelLogger.warn('Teams credentials not configured');
      return;
    }

    const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: config.teams.appId,
      MicrosoftAppPassword: config.teams.appPassword,
      MicrosoftAppTenantId: config.teams.tenantId,
    });

    this.adapter = new CloudAdapter(botFrameworkAuth);

    // Error handler
    this.adapter.onTurnError = async (context, error) => {
      channelLogger.error({ error }, 'Teams adapter error');
      this.emitError(error as Error);

      await context.sendActivity('Sorry, an error occurred. Please try again.');
    };

    await this.ensureReferencesLoaded();
    this.setConnected(true);
    channelLogger.info('Teams adapter initialized');
  }

  /**
   * Conversation references are what a proactive send (hooks, monitors,
   * notifications) needs, and Teams only hands them over on an inbound
   * activity. They are kept in kv_store under `teams:convref:<id>` so a
   * restart does not cut every user off until they message the bot again.
   */
  private async persistReference(conversationId: string, reference: unknown): Promise<void> {
    try {
      const { getDb } = await import('@/db/postgres');
      const { kvStore } = await import('@/db/schema/kv');
      const value = JSON.stringify(reference);
      await getDb()
        .insert(kvStore)
        .values({ key: `${CONVREF_PREFIX}${conversationId}`, value })
        .onConflictDoUpdate({ target: kvStore.key, set: { value } });
    } catch (err) {
      channelLogger.warn({ err, conversationId }, 'Could not persist Teams conversation reference');
    }
  }

  /** Load persisted conversation references (see persistReference). */
  async loadConversationReferences(): Promise<number> {
    try {
      const { getDb } = await import('@/db/postgres');
      const { kvStore } = await import('@/db/schema/kv');
      const { like } = await import('drizzle-orm');
      const rows = await getDb().select().from(kvStore).where(like(kvStore.key, `${CONVREF_PREFIX}%`));
      for (const row of rows) {
        const id = row.key.slice(CONVREF_PREFIX.length);
        if (this.conversationReferences.has(id)) continue;
        try {
          this.conversationReferences.set(id, JSON.parse(row.value) as Partial<Activity>);
        } catch {
          channelLogger.warn({ conversationId: id }, 'Skipping unreadable Teams conversation reference');
        }
      }
      return rows.length;
    } catch (err) {
      channelLogger.warn({ err }, 'Could not load Teams conversation references');
      return 0;
    }
  }

  /** Load the persisted references once per process (or after a disconnect). */
  ensureReferencesLoaded(): Promise<number> {
    this.referencesLoaded ??= this.loadConversationReferences();
    return this.referencesLoaded;
  }

  /** True when a conversation reference for this id is known (in memory). */
  hasConversation(conversationId: string): boolean {
    return this.conversationReferences.has(conversationId);
  }

  async disconnect(): Promise<void> {
    this.adapter = null;
    this.conversationReferences.clear();
    this.referencesLoaded = null;
    this.setConnected(false);
  }

  /**
   * Process incoming activity from Teams webhook.
   * Accepts the raw JSON body and auth header, creates a TurnContext manually.
   */
  async processActivityFromWebhook(body: Activity, authHeader: string): Promise<void> {
    if (!this.adapter) {
      throw new Error('Teams adapter not connected');
    }

    // Use the adapter's processActivity which accepts an Activity + auth header
    await (this.adapter as any).processActivity(authHeader, body, async (context: TurnContext) => {
      await this.handleActivity(context);
    });
  }

  /**
   * Handle incoming activity
   */
  async handleActivity(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Store conversation reference for proactive messaging
    const reference = {
      activityId: activity.id,
      user: activity.from,
      bot: activity.recipient,
      conversation: activity.conversation,
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
    };
    this.conversationReferences.set(activity.conversation.id, reference as Partial<Activity>);
    await this.persistReference(activity.conversation.id, reference);
    // A channel's thread replies arrive on `<channel>;messageid=<root>`; group
    // channels are keyed by the channel itself, so keep a reference for that too.
    const { base, root } = splitConversationId(activity.conversation.id);
    if (root !== undefined) {
      const baseReference = { ...reference, conversation: { ...activity.conversation, id: base } };
      this.conversationReferences.set(base, baseReference as Partial<Activity>);
      await this.persistReference(base, baseReference);
    }

    switch (activity.type) {
      case ActivityTypes.Message:
        await this.handleMessage(context);
        break;

      case ActivityTypes.ConversationUpdate:
        await this.handleConversationUpdate(context);
        break;

      case ActivityTypes.MessageReaction:
        await this.handleReaction(context);
        break;

      default:
        channelLogger.debug({ type: activity.type }, 'Unhandled Teams activity type');
    }
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const teamsUserId = activity.from.aadObjectId || activity.from.id;
    const conversationId = activity.conversation.id;
    const userName = activity.from.name;

    // Group chats and team channels follow the group-channel rules: silent
    // unless enrolled and addressed. Only 1:1 chats take the path below.
    const inbound = toGroupInbound(activity as TeamsActivityLike, activity);
    if (inbound) {
      this.accounts.delete(inbound.user); // re-insert: Map order doubles as LRU order
      this.accounts.set(inbound.user, {
        account: { id: activity.from.id, name: activity.from.name, aadObjectId: activity.from.aadObjectId },
        serviceUrl: activity.serviceUrl,
        tenantId: (activity.conversation as { tenantId?: string }).tenantId,
      });
      if (this.accounts.size > 5_000) this.accounts.delete(this.accounts.keys().next().value as string);
      try {
        await handleGroupMessage(inbound, this.groupDeps(activity));
      } catch (err) {
        channelLogger.error({ err, conversationId: inbound.channelId }, 'Teams group message handling failed');
      }
      return;
    }

    // `link` in the 1:1 chat: a code to enter under Settings → Channels.
    if (/^\/?link$/i.test((activity.text ?? '').trim())) {
      const code = await generateLinkCode({ channelType: 'teams', channelUserId: teamsUserId, channelUserName: userName });
      await context.sendActivity(`Your link code: **${code}**\n\nEnter it in the Octipus web app under Settings → Channels within 15 minutes.`);
      return;
    }

    // Find user binding (Phase 2e: scoped O(1) lookup on
    // `channel_identities`, JSONB fallback for legacy bindings).
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const user = await getChannelBindingManager().findUserRecordByExternalId('teams', teamsUserId);

    if (!user) {
      channelLogger.info({ teamsUserId, userName }, 'New Teams user - needs linking');
      await context.sendActivity('Welcome! Send me `link` to get a code, then enter it in the Octipus web app under Settings → Channels.');
      return;
    }

    // Extract attachments
    const attachments: Attachment[] = [];

    if (activity.attachments) {
      for (const attachment of activity.attachments) {
        if (attachment.contentUrl) {
          attachments.push({
            type: this.mapContentType(attachment.contentType),
            url: attachment.contentUrl,
            mimeType: attachment.contentType,
            filename: attachment.name,
          });
        }
      }
    }

    // Remove bot mentions from text
    let text = activity.text || '';
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (entity.type === 'mention' && entity.mentioned?.id === activity.recipient.id) {
          text = text.replace(entity.text || '', '').trim();
        }
      }
    }

    // Create unified message
    const message = this.createUnifiedMessage(conversationId, user.id, text, {
      userName,
      replyTo: activity.replyToId,
      threadId: activity.conversation.id,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        teamsUserId,
        activityId: activity.id,
        serviceUrl: activity.serviceUrl,
      },
    });

    this.emitMessage(message);
  }

  /**
   * 👍 / ❤️ or 😢 / 😠 on one of the bot's messages in an enrolled group chat
   * or channel: recorded as feedback on that reply (`handleGroupFeedback`).
   */
  private async handleReaction(context: TurnContext): Promise<void> {
    const activity = context.activity;
    if (conversationKind(activity as TeamsActivityLike) === 'personal' || !activity.replyToId) return;
    const { base } = splitConversationId(activity.conversation.id);
    const deps = this.groupDeps(activity);
    const changes: Array<[Array<{ type?: string }> | undefined, boolean]> = [
      [activity.reactionsAdded, false],
      [activity.reactionsRemoved, true],
    ];
    for (const [list, removed] of changes) {
      for (const reaction of list ?? []) {
        const value = TEAMS_FEEDBACK[reaction.type ?? ''];
        if (value === undefined) continue;
        await handleGroupFeedback({
          user: teamsUserKey(activity.from as TeamsActivityLike['from']), channelId: base, messageId: activity.replyToId, value, removed,
        }, deps).catch((err: unknown) => channelLogger.error({ err }, 'Teams group feedback failed'));
      }
    }
  }

  private async handleConversationUpdate(context: TurnContext): Promise<void> {
    const activity = context.activity;
    // In group chats and channels the bot stays silent until a member enrols it.
    if (conversationKind(activity as TeamsActivityLike) !== 'personal') return;

    if (activity.membersAdded) {
      for (const member of activity.membersAdded) {
        if (member.id !== activity.recipient.id) {
          await context.sendActivity('Hello! I am your AI assistant. How can I help you today?');
        }
      }
    }
  }

  /**
   * The Teams user (aadObjectId, else from.id) of a stored 1:1 ('personal')
   * conversation. Undefined for an unknown conversation and for group chats
   * and team channels, which belong to no single user.
   */
  personalConversationUser(conversationId: string): string | undefined {
    const ref = this.conversationReferences.get(conversationId) as
      | { conversation?: { conversationType?: string }; user?: { aadObjectId?: string; id?: string } }
      | undefined;
    if (!ref || ref.conversation?.conversationType !== 'personal') return undefined;
    return ref.user?.aadObjectId || ref.user?.id || undefined;
  }

  /**
   * Conversation ids of the stored 1:1 conversations with a Teams user. Teams
   * identities are keyed by aadObjectId, but a proactive send needs a
   * conversation reference; this maps one to the other.
   */
  personalConversationsFor(teamsUserId: string): string[] {
    const out: string[] = [];
    for (const id of this.conversationReferences.keys()) {
      if (this.personalConversationUser(id) === teamsUserId) out.push(id);
    }
    return out;
  }

  async send(channelId: string, response: ChannelResponse): Promise<string> {
    if (!this.adapter) {
      throw new Error('Teams adapter not connected');
    }

    const stored = this.conversationReferences.get(channelId);
    if (!stored) {
      throw new Error(`No conversation reference for channel: ${channelId}`);
    }
    // In a team channel, a reply in a thread goes to `<channel>;messageid=<root>`.
    const conversation = stored.conversation as { id: string; conversationType?: string } | undefined;
    const reference = conversation?.conversationType === 'channel' && response.threadId
      ? { ...stored, conversation: { ...conversation, id: threadConversationId(conversation.id, response.threadId) } }
      : stored;

    let activityId = '';

    await this.adapter.continueConversation(reference as Partial<Activity>, async (context) => {
      // Build the message
      let activity: Partial<Activity>;

      if (response.attachments?.length) {
        // Create adaptive card or attachments
        const attachments = response.attachments.map((att) => ({
          contentType: att.mimeType,
          contentUrl: att.url,
          name: att.filename,
        }));

        activity = MessageFactory.attachment(attachments[0], response.content);
      } else {
        activity = MessageFactory.text(response.content);
      }

      if (response.replyTo) {
        activity.replyToId = response.replyTo;
      }

      const result = await context.sendActivity(activity);
      activityId = result?.id || '';
    });

    if (this.groupConversations.has(channelId) && (response.threadId || conversation?.conversationType !== 'channel')) {
      recordGroupMessage('teams', channelId, response.threadId ?? MAIN_THREAD, {
        id: activityId || `sent-${Date.now()}`, conversationId: channelId, author: 'Octipus', authorId: BUFFER_BOT_ID,
        text: response.content, at: new Date().toISOString(),
      });
    }
    return activityId;
  }

  /**
   * A message only this Teams user sees: in their 1:1 chat with the bot,
   * opened if needed (Teams has no ephemeral messages). False when there is
   * no way to reach them privately.
   */
  private async sendDirect(userKey: string, text: string): Promise<boolean> {
    if (!this.adapter) return false;
    for (const conversationId of this.personalConversationsFor(userKey)) {
      try {
        await this.send(conversationId, { content: text });
        return true;
      } catch (err) {
        channelLogger.warn({ err, conversationId }, 'Teams 1:1 message failed');
      }
    }
    const known = this.accounts.get(userKey);
    const appId = getConfig().teams?.appId;
    if (!known || !appId) return false;
    try {
      let sent = false;
      await this.adapter.createConversationAsync(appId, 'msteams', known.serviceUrl, 'https://api.botframework.com', {
        isGroup: false,
        bot: { id: `28:${appId}`, name: 'Octipus' },
        members: [known.account],
        tenantId: known.tenantId,
        channelData: known.tenantId ? { tenant: { id: known.tenantId } } : undefined,
      } as never, async (context) => {
        const ref = {
          user: known.account,
          bot: context.activity.recipient,
          conversation: { ...context.activity.conversation, conversationType: 'personal' },
          channelId: 'msteams',
          serviceUrl: known.serviceUrl,
        };
        this.conversationReferences.set(context.activity.conversation.id, ref as Partial<Activity>);
        await this.persistReference(context.activity.conversation.id, ref);
        await context.sendActivity(MessageFactory.text(text));
        sent = true;
      });
      return sent;
    } catch (err) {
      channelLogger.warn({ err }, 'Could not open a Teams 1:1 chat for a private message');
      return false;
    }
  }

  /** The approval details etc. for a group thread: in the member's 1:1 chat with the bot. */
  override async sendPrivate(_channelId: string, userId: string, response: ChannelResponse): Promise<boolean> {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const identities = (await getChannelBindingManager().listForUser(userId))
      .filter(i => i.channelType === 'teams' && i.verifiedAt);
    let delivered = false;
    for (const identity of identities) {
      if (await this.sendDirect(identity.externalId, response.content)) delivered = true;
    }
    return delivered;
  }

  /** Platform calls for `handleGroupMessage`, for one inbound activity. */
  private groupDeps(activity: Activity): GroupDeps<Activity> {
    const kind = conversationKind(activity as TeamsActivityLike);
    const botUserId = activity.recipient.id;
    const nameOf = (key: string) => this.accounts.get(key)?.account.name;
    return {
      botUserId,
      bot: `@${activity.recipient.name || 'Octipus'}`,
      hints: HINTS,
      findGroup: async (channelId) => {
        const { findGroupChannel } = await import('@/channels/group-channels');
        return findGroupChannel('teams', channelId);
      },
      isGroupActive: async (group) => {
        const { isGroupChannelActive } = await import('@/channels/group-channels');
        return isGroupChannelActive(group);
      },
      isThreadActive: async (groupId, threadId) => {
        const { isGroupThreadActive } = await import('@/channels/group-channels');
        return isGroupThreadActive(groupId, threadId);
      },
      findMember: async (userKey): Promise<GroupMember | null> => {
        const { getChannelBindingManager } = await import('@/security/channel-bindings');
        const user = await getChannelBindingManager().findUserRecordByExternalId('teams', userKey);
        return user ? { id: user.id, username: user.username, isActive: user.isActive, isAdmin: user.isAdmin } : null;
      },
      join: async ({ channelId, label, userId }) => {
        const { joinGroupChannel } = await import('@/channels/group-channels');
        return joinGroupChannel({ channelType: 'teams', channelId, label, userId });
      },
      leave: async ({ channelId, userId, isAdmin }) => {
        const { leaveGroupChannel } = await import('@/channels/group-channels');
        return leaveGroupChannel({ channelType: 'teams', channelId, userId, isAdmin });
      },
      channelLabel: async () => {
        const name = (activity.channelData as TeamsActivityLike['channelData'])?.channel?.name ?? activity.conversation.name;
        return name ? (kind === 'channel' ? `#${name}` : name) : null;
      },
      displayName: async (userKey) => nameOf(userKey) ?? 'a member',
      postPrivate: async (userKey, text, where) => {
        if (await this.sendDirect(userKey, text)) return;
        // No way to reach them privately: answer their message in place. The
        // hints carry no secrets (never a link code).
        await this.send(where.channelId, { content: text, threadId: where.threadId ?? (kind === 'channel' ? where.messageId : undefined) })
          .catch((err: unknown) => channelLogger.error({ err }, 'Teams group: hint failed'));
      },
      postInThread: async (channelId, threadId, text) => {
        await this.send(channelId, { content: text, threadId: kind === 'channel' ? threadId : undefined })
          .catch((err: unknown) => channelLogger.error({ err }, 'Teams group: posting in the thread failed'));
      },
      readContext: async ({ channelId, messageId, replyThread, label }) => {
        const { renderGroupContext } = await import('@/core/channels/group-context');
        return renderGroupContext(groupMessages('teams', channelId, replyThread), {
          currentMessageId: messageId,
          botIds: new Set([BUFFER_BOT_ID]),
          conversationName: label ?? undefined,
          scope: kind === 'channel' ? 'thread' : 'channel',
        });
      },
      // Only messages the bot saw can be read back: one that reached it, or one it posted.
      readMessage: async (channelId, id) => {
        const found = findGroupMessageAnywhere('teams', channelId, id);
        if (!found) return null;
        const { message: m, thread } = found;
        return {
          text: m.text,
          user: m.authorId === BUFFER_BOT_ID ? botUserId : m.authorId ?? null,
          threadId: kind === 'channel' && thread !== id ? thread : undefined,
        };
      },
      permalink: async () => undefined,
      budgetPause: async (group) => {
        const { groupChannelPause } = await import('@/security/spend-budgets');
        return groupChannelPause(group.id).catch((err: unknown) => {
          channelLogger.warn({ err, groupId: group.id }, 'Group channel budget check failed — not pausing');
          return null;
        });
      },
      shouldSendHint: (key) => shouldSendHint(`teams:${key}`),
      feedback: async ({ removed, ...input }) => {
        const { recordGroupFeedback, removeGroupFeedback } = await import('@/channels/group-channels');
        if (removed) await removeGroupFeedback(input);
        else await recordGroupFeedback(input);
      },
      forget: (channelId) => {
        this.groupConversations.delete(channelId);
        forgetGroupChat('teams', channelId);
      },
      seen: (msg) => {
        this.groupConversations.add(msg.channelId);
        if (!msg.text) return;
        recordGroupMessage('teams', msg.channelId, msg.replyThread, {
          id: msg.messageId, conversationId: msg.channelId, author: nameOf(msg.user) ?? 'a member', authorId: msg.user,
          text: msg.text, at: new Date().toISOString(), addressed: msg.mentioned || msg.repliedToBot === true,
        });
      },
      dispatch: ({ channelId, member, userName, text, threadId, group, context, message, take }) => {
        const attachments: Attachment[] = (activity.attachments ?? [])
          .filter(a => a.contentUrl)
          .map(a => ({ type: this.mapContentType(a.contentType), url: a.contentUrl, mimeType: a.contentType, filename: a.name }));
        this.emitMessage(this.createUnifiedMessage(channelId, member.id, text, {
          userName,
          threadId,
          attachments: attachments.length > 0 ? attachments : undefined,
          metadata: {
            teamsUserId: message.user,
            activityId: message.messageId,
            serviceUrl: activity.serviceUrl,
            // Replies answer this message (`replyToId`).
            messageId: message.messageId,
            groupChannelId: group.id,
            groupContext: context,
            ...(take ? { take } : {}),
          },
        }));
      },
    };
  }

  override async sendTyping(channelId: string, _active: boolean = true): Promise<void> {
    if (!this.adapter) return;
    const reference = this.conversationReferences.get(channelId);
    // In a team channel the indicator would go to the channel, not the thread.
    if (!reference || (reference.conversation as { conversationType?: string } | undefined)?.conversationType === 'channel') return;
    try {
      await this.adapter.continueConversation(reference as Partial<Activity>, async (context) => {
        await context.sendActivity({ type: 'typing' });
      });
    } catch {
      // Silently ignore
    }
  }

  // Teams doesn't natively support emoji reactions on bot messages via Bot Framework SDK

  private mapContentType(contentType: string): Attachment['type'] {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'file';
  }

  /**
   * Get the adapter for use in API routes
   */
  getAdapter(): CloudAdapter | null {
    return this.adapter;
  }
}

export const teamsChannel = new TeamsChannel();
