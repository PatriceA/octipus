import { getUMI } from '@/channels/interface';
import type { ToolManifest } from '@/core/types';
import { BaseTool, createParameterSchema } from '../base-tool';

export class MessagingTool extends BaseTool {
  readonly id = 'messaging';
  readonly name = 'Cross-Channel Messaging';
  readonly version = '1.1.0';
  readonly description = 'Send messages across channels (Telegram, Slack, Teams, WhatsApp, WebChat), list channels, and look up user contacts.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'send', description: 'Send messages to connected channels on behalf of the user', defaultLevel: 'ASK' },
        { action: 'list', description: 'List connected channels and user contacts', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'send_message', description: 'Send a message to a specific channel + target', parameters: { channel: { type: 'string', description: 'Channel type', required: true }, target: { type: 'string', description: 'Target ID', required: true }, message: { type: 'string', description: 'Message content', required: true } }, returns: 'Delivery confirmation' },
        { name: 'send_to_user', description: 'Send a message to a user on their linked channels', parameters: { user_id: { type: 'string', description: 'User ID', required: true }, message: { type: 'string', description: 'Message content', required: true } }, returns: 'Per-channel delivery results' },
        { name: 'list_channels', description: 'List connected messaging channels', parameters: {}, returns: 'Channel list with status' },
        { name: 'list_contacts', description: 'List users with their linked channel accounts', parameters: {}, returns: 'User contact list' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'send_message',
      'Send a message to a specific channel and target ID. Use list_channels to see available channels and list_contacts to find user IDs.',
      createParameterSchema({
        channel: { type: 'string', description: 'Channel type: telegram, slack, teams, whatsapp, or webchat', required: true },
        target: { type: 'string', description: 'Target channel/chat/user ID', required: true },
        message: { type: 'string', description: 'Message content to send', required: true },
        reply_to: { type: 'string', description: 'Thread or message ID to reply to (optional)' },
      }),
      async (args) => {
        const umi = getUMI();
        const channel = args.channel as string;
        const target = args.target as string;

        if (!umi.isChannelAvailable(channel as any)) {
          return { success: false, error: `Channel ${channel} is not connected` };
        }

        try {
          const messageId = await umi.send(channel as any, target, {
            content: args.message as string,
          });
          return { success: true, messageId, channel, target };
        } catch (err) {
          return { success: false, error: (err as Error).message };
        }
      },
    );

    this.registerTool(
      'send_to_user',
      'Send a message to a user on their linked channels. Looks up the user\'s verified channel bindings and sends to all (or a specific channel).',
      createParameterSchema({
        user_id: { type: 'string', description: 'User ID to send to', required: true },
        message: { type: 'string', description: 'Message content', required: true },
        channel: { type: 'string', description: 'Specific channel to use (optional — sends to all verified channels if omitted)' },
      }),
      async (args) => {
        const { userRepository } = await import('@/db/repositories/user-repository');
        const user = await userRepository.findById(args.user_id as string);
        if (!user) return { success: false, error: 'User not found' };

        let rawBindings = user.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
        if (typeof rawBindings === 'string') {
          try { rawBindings = JSON.parse(rawBindings); } catch { rawBindings = []; }
        }
        const bindings = (rawBindings as import('@/db/schema/users').ChannelBinding[]) || [];
        const verified = bindings.filter(b => b.isVerified);

        if (verified.length === 0) {
          return { success: false, error: 'User has no verified channel bindings' };
        }

        const targetChannel = args.channel as string | undefined;
        const targets = targetChannel
          ? verified.filter(b => b.channelType === targetChannel)
          : verified;

        if (targets.length === 0) {
          return { success: false, error: `User has no verified binding for channel: ${targetChannel}` };
        }

        const umi = getUMI();
        const results: { channel: string; success: boolean; error?: string }[] = [];

        for (const binding of targets) {
          try {
            if (!umi.isChannelAvailable(binding.channelType as any)) {
              results.push({ channel: binding.channelType, success: false, error: 'Channel not connected' });
              continue;
            }
            await umi.send(binding.channelType as any, binding.channelUserId, {
              content: args.message as string,
            });
            results.push({ channel: binding.channelType, success: true });
          } catch (err) {
            results.push({ channel: binding.channelType, success: false, error: (err as Error).message });
          }
        }

        return { success: results.some(r => r.success), results };
      },
    );

    this.registerTool(
      'list_channels',
      'List all registered messaging channels and their connection status.',
      createParameterSchema({}),
      async () => {
        const umi = getUMI();
        const channels = umi.getAllChannels();
        return {
          channels: channels.map(ch => ({
            type: ch.type,
            name: ch.name,
            connected: ch.isConnected(),
          })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'list_contacts',
      'List users who have linked channel accounts. Shows which channels each user can be reached on.',
      createParameterSchema({}),
      async () => {
        const { userRepository } = await import('@/db/repositories/user-repository');
        const users = await userRepository.listAll();

        const contacts = users
          .filter(u => {
            let bindings = u.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
            if (typeof bindings === 'string') {
              try { bindings = JSON.parse(bindings); } catch { return false; }
            }
            return Array.isArray(bindings) && bindings.some(b => b.isVerified);
          })
          .map(u => {
            let bindings = u.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
            if (typeof bindings === 'string') {
              try { bindings = JSON.parse(bindings); } catch { bindings = []; }
            }
            const verified = (bindings as import('@/db/schema/users').ChannelBinding[]).filter(b => b.isVerified);
            return {
              userId: u.id,
              displayName: u.username || u.id,
              channels: verified.map(b => ({
                type: b.channelType,
                channelUserId: b.channelUserId,
                channelUserName: b.channelUserName,
              })),
            };
          });

        return { contacts };
      },
      { requiresPermission: false },
    );
  }
}

export const messagingTool = new MessagingTool();
