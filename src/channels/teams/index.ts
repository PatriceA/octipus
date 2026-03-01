import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type Activity,
  type TurnContext,
  ActivityTypes,
  MessageFactory,
} from 'botbuilder';
import { BaseChannel } from '../interface';
import { getConfig } from '@/config';
import { userRepository } from '@/db/repositories/user-repository';
import { channelLogger } from '@/utils/logger';
import type { ChannelType, ChannelResponse, Attachment } from '@/core/types';

export class TeamsChannel extends BaseChannel {
  readonly type: ChannelType = 'teams';
  readonly name = 'Microsoft Teams';

  private adapter: CloudAdapter | null = null;
  private conversationReferences: Map<string, Partial<Activity>> = new Map();

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

    this.setConnected(true);
    channelLogger.info('Teams adapter initialized');
  }

  async disconnect(): Promise<void> {
    this.adapter = null;
    this.conversationReferences.clear();
    this.setConnected(false);
  }

  /**
   * Process incoming activity from Teams webhook
   */
  async processActivity(req: Request, res: Response): Promise<void> {
    if (!this.adapter) {
      throw new Error('Teams adapter not connected');
    }

    // Note: In a real implementation, you'd use the adapter's process method
    // with the HTTP request/response objects from your web server (Elysia)
    // This is a simplified version

    // The actual processing would be done through:
    // await this.adapter.process(req, res, async (context) => {
    //   await this.handleActivity(context);
    // });
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

    // Find user binding
    let user = await userRepository.findByChannelBinding('teams', teamsUserId);

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
