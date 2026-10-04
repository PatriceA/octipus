import type { ChannelResponse, ChannelType } from '@/core/types';
import { generateId } from '@/utils/crypto';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from '../interface';

/**
 * The in-app surface (the web app, and any other gateway client of the
 * user). It has no sockets of its own: the browser holds one `/gateway`
 * connection per tab, and a delivery here is a user-stamped `chat.message`
 * event on the gateway, which reaches every tab of that user and nobody
 * else's.
 *
 * Addressed by user id (`webchat:<userId>`, see `channels/ownership.ts`):
 * the only valid target is the user's own id.
 */
export class WebChatChannel extends BaseChannel {
  readonly type: ChannelType = 'webchat';
  readonly name = 'Web Chat';

  async connect(): Promise<void> {
    // Nothing to connect to: delivery goes through the gateway hub.
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    this.setConnected(false);
  }

  /** `channelId` is the user id this channel addresses. */
  async send(channelId: string, response: ChannelResponse): Promise<string> {
    const [messageId] = await this.sendToUser(channelId, response);
    return messageId;
  }

  /**
   * Deliver to every open gateway connection of `userId` as a `chat.message`
   * event (`proactive: true`). Throws when the user has none open, so the
   * caller can tell an unread delivery from a delivered one.
   */
  async sendToUser(userId: string, response: ChannelResponse): Promise<string[]> {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const hub = getGatewayHub();
    if (hub.connectionManager.getConnectionsByUser(userId).length === 0) {
      throw new Error(`No active connections for user: ${userId}`);
    }

    const messageId = generateId();
    const sessionId = typeof response.metadata?.sessionId === 'string' ? response.metadata.sessionId : undefined;
    hub.publishEvent({
      type: 'chat.message',
      source: 'webchat',
      userId,
      ...(sessionId ? { sessionId } : {}),
      payload: {
        role: 'assistant',
        content: response.content,
        proactive: true,
        messageId,
        timestamp: new Date().toISOString(),
        ...(response.attachments?.length ? { attachments: response.attachments } : {}),
        ...(response.metadata ? { metadata: response.metadata } : {}),
      },
    });
    channelLogger.debug({ userId, messageId }, 'In-app delivery published to the gateway');
    return [messageId];
  }
}

export const webChatChannel = new WebChatChannel();
