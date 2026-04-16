import { BaseChannel } from '../interface';
import { userRepository } from '@/db/repositories/user-repository';
import { channelLogger } from '@/utils/logger';
import { generateId } from '@/utils/crypto';
import type { ChannelType, ChannelResponse, Attachment, } from '@/core/types';

export interface WebChatConnection {
  id: string;
  userId: string;
  sessionId?: string;
  send: (data: unknown) => void;
  close: () => void;
}

export interface WebChatMessage {
  type: 'message' | 'typing' | 'status' | 'error';
  content?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export class WebChatChannel extends BaseChannel {
  readonly type: ChannelType = 'webchat';
  readonly name = 'Web Chat';

  private connections: Map<string, WebChatConnection> = new Map();
  private userConnections: Map<string, Set<string>> = new Map();

  async connect(): Promise<void> {
    // WebChat doesn't need to connect to external services
    // It receives connections from the WebSocket server
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    // Close all connections
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
    this.userConnections.clear();
    this.setConnected(false);
  }

  /**
   * Register a new WebSocket connection
   */
  registerConnection(
    userId: string,
    send: (data: unknown) => void,
    close: () => void,
    sessionId?: string
  ): string {
    const connectionId = generateId();

    const connection: WebChatConnection = {
      id: connectionId,
      userId,
      sessionId,
      send,
      close,
    };

    this.connections.set(connectionId, connection);

    // Track user's connections
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set());
    }
    this.userConnections.get(userId)!.add(connectionId);

    channelLogger.info({ connectionId, userId }, 'WebChat connection registered');

    return connectionId;
  }

  /**
   * Unregister a connection
   */
  unregisterConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      const userConns = this.userConnections.get(connection.userId);
      if (userConns) {
        userConns.delete(connectionId);
        if (userConns.size === 0) {
          this.userConnections.delete(connection.userId);
        }
      }
      this.connections.delete(connectionId);
      channelLogger.info({ connectionId }, 'WebChat connection unregistered');
    }
  }

  /**
   * Handle incoming message from WebSocket
   */
  async handleIncoming(connectionId: string, message: WebChatMessage): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      channelLogger.warn({ connectionId }, 'Message from unknown connection');
      return;
    }

    if (message.type !== 'message') {
      return;
    }

    // Verify user exists
    const user = await userRepository.findById(connection.userId);
    if (!user) {
      connection.send({
        type: 'error',
        content: 'User not found. Please log in again.',
      });
      return;
    }

    // Create unified message
    const unifiedMessage = this.createUnifiedMessage(
      connectionId,
      connection.userId,
      message.content || '',
      {
        userName: user.username,
        attachments: message.attachments,
        metadata: {
          ...message.metadata,
          sessionId: connection.sessionId,
        },
      }
    );

    this.emitMessage(unifiedMessage);
  }

  async send(channelId: string, response: ChannelResponse): Promise<string> {
    const connection = this.connections.get(channelId);
    if (!connection) {
      throw new Error(`WebChat connection not found: ${channelId}`);
    }

    const messageId = generateId();

    const message: WebChatMessage = {
      type: 'message',
      content: response.content,
      attachments: response.attachments,
      metadata: {
        ...response.metadata,
        messageId,
        timestamp: new Date().toISOString(),
      },
    };

    connection.send(message);

    return messageId;
  }

  /**
   * Send to all connections for a user
   */
  async sendToUser(userId: string, response: ChannelResponse): Promise<string[]> {
    const connectionIds = this.userConnections.get(userId);
    if (!connectionIds || connectionIds.size === 0) {
      throw new Error(`No active connections for user: ${userId}`);
    }

    const messageIds: string[] = [];

    for (const connectionId of connectionIds) {
      try {
        const messageId = await this.send(connectionId, response);
        messageIds.push(messageId);
      } catch (error) {
        channelLogger.error({ error, connectionId }, 'Failed to send to connection');
      }
    }

    return messageIds;
  }

  /**
   * BaseChannel override: send typing indicator by channelId (sessionId)
   */
  override async sendTyping(channelId: string, active: boolean = true): Promise<void> {
    // WebChat channelId is the sessionId — find connections for this session
    for (const [, connection] of this.connections) {
      if ((connection as any).sessionId === channelId) {
        connection.send({ type: active ? 'typing' : 'typing_stop' });
      }
    }
  }

  /**
   * BaseChannel override: send emoji reaction by channelId
   */
  override async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    for (const [, connection] of this.connections) {
      if ((connection as any).sessionId === channelId) {
        connection.send({ type: 'reaction', messageId, emoji });
      }
    }
  }

  /**
   * Send status update
   */
  sendStatus(connectionId: string, status: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.send({ type: 'status', content: status });
    }
  }

  /**
   * Broadcast to all connections
   */
  broadcast(message: WebChatMessage): void {
    for (const connection of this.connections.values()) {
      try {
        connection.send(message);
      } catch (error) {
        channelLogger.error({ error, connectionId: connection.id }, 'Broadcast failed');
      }
    }
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get user's connection count
   */
  getUserConnectionCount(userId: string): number {
    return this.userConnections.get(userId)?.size || 0;
  }

  /**
   * Check if user is online
   */
  isUserOnline(userId: string): boolean {
    return this.getUserConnectionCount(userId) > 0;
  }

  /**
   * Get all online user IDs
   */
  getOnlineUsers(): string[] {
    return Array.from(this.userConnections.keys());
  }
}

export const webChatChannel = new WebChatChannel();
