import { EventEmitter } from 'events';
import type { UnifiedMessage, ChannelResponse, ChannelType, Attachment } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import { generateId } from '@/utils/crypto';

export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface ChannelEvents {
  message: (message: UnifiedMessage) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * Base interface for all messaging channels
 */
export abstract class BaseChannel extends EventEmitter {
  abstract readonly type: ChannelType;
  abstract readonly name: string;

  protected connected = false;

  /**
   * Initialize and connect the channel
   */
  abstract connect(): Promise<void>;

  /**
   * Disconnect the channel
   */
  abstract disconnect(): Promise<void>;

  /**
   * Send a response message
   */
  abstract send(channelId: string, response: ChannelResponse): Promise<string>;

  /**
   * Check if the channel is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Reconnect the channel (disconnect + connect).
   * Used for hot-reload when config changes at runtime.
   */
  async reconnect(): Promise<void> {
    channelLogger.info({ channel: this.type }, 'Reconnecting channel');
    await this.disconnect();
    await this.connect();
  }

  /**
   * Create a unified message from channel-specific data
   */
  protected createUnifiedMessage(
    channelId: string,
    userId: string,
    content: string,
    options?: {
      userName?: string;
      replyTo?: string;
      threadId?: string;
      attachments?: Attachment[];
      metadata?: Record<string, unknown>;
    }
  ): UnifiedMessage {
    return {
      id: generateId(),
      channelType: this.type,
      channelId,
      userId,
      userName: options?.userName,
      content,
      replyTo: options?.replyTo,
      threadId: options?.threadId,
      attachments: options?.attachments,
      timestamp: new Date(),
      metadata: options?.metadata,
    };
  }

  /**
   * Emit a message event
   */
  protected emitMessage(message: UnifiedMessage): void {
    channelLogger.debug({ channel: this.type, messageId: message.id }, 'Message received');
    this.emit('message', message);
  }

  /**
   * Emit an error event
   */
  protected emitError(error: Error): void {
    channelLogger.error({ error, channel: this.type }, 'Channel error');
    this.emit('error', error);
  }

  /**
   * Log connection state change
   */
  protected setConnected(state: boolean): void {
    this.connected = state;
    if (state) {
      channelLogger.info({ channel: this.type }, 'Channel connected');
      this.emit('connected');
    } else {
      channelLogger.info({ channel: this.type }, 'Channel disconnected');
      this.emit('disconnected');
    }
  }
}

/**
 * Unified Message Interface - manages all channels
 */
export class UnifiedMessageInterface extends EventEmitter {
  private channels: Map<ChannelType, BaseChannel> = new Map();

  /**
   * Register a channel
   */
  register(channel: BaseChannel): void {
    this.channels.set(channel.type, channel);

    // Forward events
    channel.on('message', (message: UnifiedMessage) => {
      this.emit('message', message);
    });

    channel.on('error', (error: Error) => {
      this.emit('error', channel.type, error);
    });

    channel.on('connected', () => {
      this.emit('channelConnected', channel.type);
    });

    channel.on('disconnected', () => {
      this.emit('channelDisconnected', channel.type);
    });

    channelLogger.info({ channel: channel.type }, 'Channel registered');
  }

  /**
   * Unregister a channel (removes it and all its event listeners)
   */
  unregister(type: ChannelType): void {
    const channel = this.channels.get(type);
    if (channel) {
      channel.removeAllListeners();
      this.channels.delete(type);
      channelLogger.info({ channel: type }, 'Channel unregistered');
    }
  }

  /**
   * Connect all registered channels
   */
  async connectAll(): Promise<void> {
    const promises = Array.from(this.channels.values()).map(async (channel) => {
      try {
        await channel.connect();
      } catch (error) {
        channelLogger.error({ error, channel: channel.type }, 'Failed to connect channel');
      }
    });

    await Promise.all(promises);
  }

  /**
   * Disconnect all channels
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.channels.values()).map(async (channel) => {
      try {
        await channel.disconnect();
      } catch (error) {
        channelLogger.error({ error, channel: channel.type }, 'Failed to disconnect channel');
      }
    });

    await Promise.all(promises);
  }

  /**
   * Get a specific channel
   */
  getChannel(type: ChannelType): BaseChannel | undefined {
    return this.channels.get(type);
  }

  /**
   * Send a message to a specific channel
   */
  async send(channelType: ChannelType, channelId: string, response: ChannelResponse): Promise<string> {
    const channel = this.channels.get(channelType);
    if (!channel) {
      throw new Error(`Channel not registered: ${channelType}`);
    }

    if (!channel.isConnected()) {
      throw new Error(`Channel not connected: ${channelType}`);
    }

    return channel.send(channelId, response);
  }

  /**
   * Get all registered channels
   */
  getAllChannels(): BaseChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get connected channels
   */
  getConnectedChannels(): BaseChannel[] {
    return Array.from(this.channels.values()).filter((c) => c.isConnected());
  }

  /**
   * Check if a channel is registered and connected
   */
  isChannelAvailable(type: ChannelType): boolean {
    const channel = this.channels.get(type);
    return channel?.isConnected() || false;
  }
}

// Singleton instance
let umiInstance: UnifiedMessageInterface | null = null;

export function getUMI(): UnifiedMessageInterface {
  if (!umiInstance) {
    umiInstance = new UnifiedMessageInterface();
  }
  return umiInstance;
}
