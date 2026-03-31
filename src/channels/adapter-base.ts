import { channelLogger } from '@/utils/logger';
import type { ChannelType, ChannelResponse, Attachment } from '@/core/types';

// ── Adapter ↔ Gateway Protocol ────────────────────────────────────

/**
 * Messages from an adapter to the gateway (via channel.* message types).
 */
export interface AdapterToGateway {
  /** An incoming message from a channel user */
  'channel.message': {
    channel: ChannelType;
    channelId: string;
    userId: string;
    userName?: string;
    content: string;
    attachments?: Attachment[];
    replyTo?: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  };
  /** Adapter status report */
  'channel.status': {
    channel: ChannelType;
    connected: boolean;
    error?: string;
  };
}

/**
 * Messages from the gateway to an adapter.
 */
export interface GatewayToAdapter {
  /** Send a response to a channel user */
  'channel.send': {
    channel: ChannelType;
    channelId: string;
    content: string;
    replyTo?: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  };
  /** Set a reaction emoji on a message */
  'channel.react': {
    channel: ChannelType;
    channelId: string;
    messageId: string;
    emoji: string;
  };
  /** Show typing indicator */
  'channel.typing': {
    channel: ChannelType;
    channelId: string;
    active: boolean;
  };
}

// ── Gateway-Connected Adapter Base ────────────────────────────────

/**
 * Base class for channel adapters that connect to the gateway via WebSocket.
 *
 * In the current architecture, adapters still run in-process but communicate
 * through the gateway event bus instead of the old UMI EventEmitter.
 * Future: adapters run as separate processes, connecting via ws://localhost:3007/gateway.
 */
export abstract class GatewayAdapter {
  abstract readonly channelType: ChannelType;
  abstract readonly name: string;

  protected connected = false;

  // Gateway send callback — set by the gateway when registering the adapter
  private gatewaySend?: (type: string, payload: unknown) => void;
  // Gateway handler for incoming messages from the gateway
  private gatewayMessageHandlers: Map<string, (payload: unknown) => Promise<void>> = new Map();

  /**
   * Initialize the channel-specific client (e.g., start Telegram polling).
   */
  abstract start(): Promise<void>;

  /**
   * Stop the channel-specific client.
   */
  abstract stop(): Promise<void>;

  /**
   * Handle a "channel.send" from the gateway — deliver a response to the channel user.
   */
  abstract handleSend(payload: GatewayToAdapter['channel.send']): Promise<void>;

  /**
   * Handle a "channel.react" from the gateway — add emoji reaction to a message.
   * Optional — not all channels support reactions.
   */
  async handleReact(payload: GatewayToAdapter['channel.react']): Promise<void> {
    // Default: no-op. Override in channels that support reactions.
  }

  /**
   * Handle a "channel.typing" from the gateway — show/hide typing indicator.
   * Optional — not all channels support typing indicators.
   */
  async handleTyping(payload: GatewayToAdapter['channel.typing']): Promise<void> {
    // Default: no-op. Override in channels that support typing.
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Gateway Integration ───────────────────────────────────────

  /**
   * Called by the gateway to register the send callback.
   */
  setGatewaySend(send: (type: string, payload: unknown) => void): void {
    this.gatewaySend = send;
  }

  /**
   * Called by the gateway when it receives a message for this adapter.
   */
  async handleGatewayMessage(type: string, payload: unknown): Promise<void> {
    switch (type) {
      case 'channel.send':
        await this.handleSend(payload as GatewayToAdapter['channel.send']);
        break;
      case 'channel.react':
        await this.handleReact(payload as GatewayToAdapter['channel.react']);
        break;
      case 'channel.typing':
        await this.handleTyping(payload as GatewayToAdapter['channel.typing']);
        break;
      default:
        channelLogger.warn({ channelType: this.channelType, type }, 'Unknown gateway message type');
    }
  }

  // ── Emit to Gateway ─────────────────────────────────────────

  /**
   * Emit an incoming channel message to the gateway.
   */
  protected emitMessage(msg: AdapterToGateway['channel.message']): void {
    channelLogger.debug({ channel: this.channelType, userId: msg.userId }, 'Adapter emitting message');
    this.gatewaySend?.('channel.message', msg);
  }

  /**
   * Emit adapter status to the gateway.
   */
  protected emitStatus(connected: boolean, error?: string): void {
    this.connected = connected;
    this.gatewaySend?.('channel.status', {
      channel: this.channelType,
      connected,
      error,
    });
  }
}
