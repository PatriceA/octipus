import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { getUMI } from '@/channels/interface';

export class MessagingTool extends BaseTool {
  readonly id = 'messaging';
  readonly name = 'Cross-Channel Messaging';
  readonly version = '1.0.0';
  readonly description = 'Send messages to channels (Telegram, Slack, Teams, WebChat) and list available channels.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'send', description: 'Send messages to connected channels (Telegram, Slack, Teams, WebChat) on your behalf', defaultLevel: 'ASK' },
        { action: 'list', description: 'List connected messaging channels and their connection status', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'send_message', description: 'Send a message to a specific channel', parameters: { channel_type: { type: 'string', description: 'Channel type', required: true }, channel_id: { type: 'string', description: 'Channel ID', required: true }, message: { type: 'string', description: 'Message content', required: true } }, returns: 'Message delivery confirmation' },
        { name: 'list_channels', description: 'List available messaging channels', parameters: {}, returns: 'List of channels with connection status' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'send_message',
      'Send a message to a specific channel (telegram, slack, teams, webchat). Requires the channel to be connected.',
      createParameterSchema({
        channel_type: { type: 'string', description: 'Channel type: telegram, slack, teams, or webchat', required: true },
        channel_id: { type: 'string', description: 'Target channel/chat ID', required: true },
        message: { type: 'string', description: 'Message content to send', required: true },
      }),
      async (args) => {
        const umi = getUMI();
        const channelType = args.channel_type as string;
        const channelId = args.channel_id as string;

        if (!umi.isChannelAvailable(channelType as any)) {
          return { error: `Channel ${channelType} is not connected or available` };
        }

        const messageId = await umi.send(channelType as any, channelId, {
          content: args.message as string,
        });

        return { success: true, messageId, channel: channelType, channelId };
      },
    );

    this.registerTool(
      'list_channels',
      'List all available messaging channels and their connection status.',
      createParameterSchema({}),
      async () => {
        const umi = getUMI();
        const channels = umi.getAllChannels();

        return {
          channels: channels.map(ch => ({
            type: ch.type,
            connected: ch.isConnected(),
          })),
        };
      },
      { requiresPermission: false },
    );
  }
}

export const messagingTool = new MessagingTool();
