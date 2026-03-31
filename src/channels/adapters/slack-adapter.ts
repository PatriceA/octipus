import { GatewayAdapter } from '../adapter-base';
import type { GatewayToAdapter } from '../adapter-base';
import type { ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';

/**
 * Gateway-compatible wrapper for the existing SlackChannel.
 * Same transitional pattern as TelegramGatewayAdapter.
 */
export class SlackGatewayAdapter extends GatewayAdapter {
  readonly channelType: ChannelType = 'slack';
  readonly name = 'Slack (Gateway)';

  private legacyChannel: any = null;

  async start(): Promise<void> {
    try {
      const { SlackChannel } = await import('../slack');
      this.legacyChannel = new SlackChannel();

      this.legacyChannel.on('message', (msg: any) => {
        this.emitMessage({
          channel: 'slack',
          channelId: msg.channelId,
          userId: msg.userId,
          userName: msg.userName,
          content: msg.content,
          attachments: msg.attachments,
          threadId: msg.threadId,
          metadata: msg.metadata,
        });
      });

      this.legacyChannel.on('connected', () => {
        this.emitStatus(true);
      });

      this.legacyChannel.on('error', (err: Error) => {
        channelLogger.error({ err, channel: 'slack' }, 'Slack adapter error');
        this.emitStatus(false, err.message);
      });

      await this.legacyChannel.connect();
    } catch (err) {
      channelLogger.error({ err }, 'Failed to start Slack adapter');
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
