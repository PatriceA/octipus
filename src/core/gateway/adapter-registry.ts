import { coreLogger } from '@/utils/logger';
import type { GatewayHub } from './hub';
import type { GatewayAdapter, AdapterToGateway } from '@/channels/adapter-base';
import type { ChannelType } from '@/core/types';

/**
 * Registry for channel adapters connected to the gateway.
 * Routes messages between adapters and the orchestrator.
 */
export class AdapterRegistry {
  private adapters: Map<ChannelType, GatewayAdapter> = new Map();
  private hub: GatewayHub;

  constructor(hub: GatewayHub) {
    this.hub = hub;
  }

  /**
   * Register an adapter with the gateway.
   */
  register(adapter: GatewayAdapter): void {
    // Set up the gateway send callback
    adapter.setGatewaySend((type, payload) => {
      this.handleAdapterMessage(adapter.channelType, type, payload);
    });

    this.adapters.set(adapter.channelType, adapter);
    coreLogger.info({ channel: adapter.channelType }, 'Adapter registered with gateway');
  }

  /**
   * Get an adapter by channel type.
   */
  get(channelType: ChannelType): GatewayAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /**
   * Get all registered adapters.
   */
  getAll(): GatewayAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Start all registered adapters.
   */
  async startAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.start();
        coreLogger.info({ channel: type }, 'Adapter started');
      } catch (err) {
        coreLogger.error({ err, channel: type }, 'Adapter start failed');
      }
    }
  }

  /**
   * Stop all registered adapters.
   */
  async stopAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.stop();
        coreLogger.info({ channel: type }, 'Adapter stopped');
      } catch (err) {
        coreLogger.error({ err, channel: type }, 'Adapter stop failed');
      }
    }
  }

  /**
   * Send a message to a specific channel adapter.
   */
  async sendToChannel(channelType: ChannelType, type: string, payload: unknown): Promise<void> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      coreLogger.warn({ channelType, type }, 'No adapter registered for channel');
      return;
    }
    await adapter.handleGatewayMessage(type, payload);
  }

  /**
   * Handle a message from an adapter (incoming channel message → orchestrator).
   */
  private handleAdapterMessage(channelType: ChannelType, type: string, payload: unknown): void {
    if (type === 'channel.message') {
      this.routeIncomingMessage(channelType, payload as AdapterToGateway['channel.message']);
    } else if (type === 'channel.status') {
      this.hub.publishEvent({
        type: 'channel.status',
        source: `adapter:${channelType}`,
        payload,
      });
    }
  }

  /**
   * Route an incoming channel message to the orchestrator.
   */
  private async routeIncomingMessage(channelType: ChannelType, msg: AdapterToGateway['channel.message']): Promise<void> {
    try {
      const { getOrchestratorService } = await import('@/core/orchestrator');
      const orchestrator = getOrchestratorService();

      // Resolve user → session (existing channel session resolution)
      const { getSessionManager } = await import('@/security/auth/session');
      const sessionManager = getSessionManager();

      // Look up or create a session for this channel user
      // The channel's userId format is typically "channelType:platformUserId"
      const channelUserId = `${channelType}:${msg.userId}`;

      const result = await orchestrator.handleMessage(
        '', // sessionId — orchestrator creates if empty
        channelUserId,
        msg.content,
        channelType,
      );

      // Route response back to the channel adapter
      if (result.response) {
        await this.sendToChannel(channelType, 'channel.send', {
          channel: channelType,
          channelId: msg.channelId,
          content: result.response,
          replyTo: msg.metadata?.messageId as string | undefined,
          threadId: msg.threadId,
        });
      }

      // Publish event for dashboard/monitoring
      this.hub.publishEvent({
        type: 'chat.response',
        source: 'orchestrator',
        sessionId: result.sessionId,
        payload: {
          response: result.response,
          channelType,
          channelId: msg.channelId,
        },
      });
    } catch (err) {
      coreLogger.error({ err, channelType, userId: msg.userId }, 'Error routing channel message');
    }
  }
}
