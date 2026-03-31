import { GatewayAdapter } from '../adapter-base';
import type { GatewayToAdapter } from '../adapter-base';
import type { ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';

/**
 * Gateway-compatible wrapper for the existing TelegramChannel.
 * Bridges between the legacy BaseChannel interface and the new GatewayAdapter protocol.
 *
 * This is a transitional adapter — once the gateway is the sole message bus,
 * the Grammy bot logic can be inlined directly here and the old TelegramChannel removed.
 */
export class TelegramGatewayAdapter extends GatewayAdapter {
  readonly channelType: ChannelType = 'telegram';
  readonly name = 'Telegram (Gateway)';

  private legacyChannel: any = null;

  async start(): Promise<void> {
    try {
      const { TelegramChannel } = await import('../telegram');
      this.legacyChannel = new TelegramChannel();

      // Bridge: legacy channel message events → gateway adapter protocol
      this.legacyChannel.on('message', (msg: any) => {
        this.emitMessage({
          channel: 'telegram',
          channelId: msg.channelId,
          userId: msg.userId,
          userName: msg.userName,
          content: msg.content,
          attachments: msg.attachments,
          replyTo: msg.replyTo,
          threadId: msg.threadId,
          metadata: msg.metadata,
        });
      });

      this.legacyChannel.on('connected', () => {
        this.emitStatus(true);
      });

      this.legacyChannel.on('error', (err: Error) => {
        channelLogger.error({ err, channel: 'telegram' }, 'Telegram adapter error');
        this.emitStatus(false, err.message);
      });

      await this.legacyChannel.connect();
    } catch (err) {
      channelLogger.error({ err }, 'Failed to start Telegram adapter');
      this.emitStatus(false, (err as Error).message);
    }
  }

  async stop(): Promise<void> {
    if (this.legacyChannel) {
      await this.legacyChannel.disconnect();
      this.legacyChannel = null;
    }
    this.emitStatus(false);
  }

  async handleSend(payload: GatewayToAdapter['channel.send']): Promise<void> {
    if (!this.legacyChannel) return;
    await this.legacyChannel.send(payload.channelId, {
      content: payload.content,
      replyTo: payload.replyTo,
      threadId: payload.threadId,
    });
  }
}
