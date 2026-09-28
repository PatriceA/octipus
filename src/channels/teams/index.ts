import {
  type Activity,
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  MessageFactory,
  type TurnContext,
} from 'botbuilder';
import { getConfig } from '@/config';
import type { Config } from '@/config/schema';
import type { Attachment, ChannelResponse, ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';

const CONVREF_PREFIX = 'teams:convref:';

export class TeamsChannel extends BaseChannel {
  readonly type: ChannelType = 'teams';
  readonly name = 'Microsoft Teams';

  private adapter: CloudAdapter | null = null;
  private conversationReferences: Map<string, Partial<Activity>> = new Map();
  private referencesLoaded: Promise<number> | null = null;

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

    switch (activity.type) {
      case ActivityTypes.Message:
        await this.handleMessage(context);
        break;

      case ActivityTypes.ConversationUpdate:
        await this.handleConversationUpdate(context);
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

    // Find user binding (Phase 2e: scoped O(1) lookup on
    // `channel_identities`, JSONB fallback for legacy bindings).
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const user = await getChannelBindingManager().findUserRecordByExternalId('teams', teamsUserId);

    if (!user) {
      channelLogger.info({ teamsUserId, userName }, 'New Teams user - needs linking');
      await context.sendActivity('Welcome! Please link your account. Contact an administrator for assistance.');
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

  private async handleConversationUpdate(context: TurnContext): Promise<void> {
    const activity = context.activity;

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

    const reference = this.conversationReferences.get(channelId);
    if (!reference) {
      throw new Error(`No conversation reference for channel: ${channelId}`);
    }

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

    return activityId;
  }

  override async sendTyping(channelId: string, _active: boolean = true): Promise<void> {
    if (!this.adapter) return;
    const reference = this.conversationReferences.get(channelId);
    if (!reference) return;
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
