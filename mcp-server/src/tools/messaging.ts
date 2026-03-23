/**
 * Messaging tools — send messages across channels and list available channels/contacts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerMessagingTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_send_channel_message',
    'Send a message to a specific channel (telegram, slack, teams, whatsapp, webchat).',
    {
      channel: z.string().describe('Channel type: telegram, slack, teams, whatsapp, or webchat'),
      target: z.string().describe('Channel or user ID to send to'),
      message: z.string().describe('Message content'),
      reply_to: z.string().optional().describe('Thread or message ID to reply to'),
    },
    async ({ channel, target, message, reply_to }) => {
      try {
        const result = await client.sendChannelMessage(channel, target, message, reply_to);
        if (result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: `Message sent to ${channel}/${target} (ID: ${result.messageId})`,
            }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
          isError: true,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_list_channels',
    'List all registered messaging channels and their connection status.',
    {},
    async () => {
      try {
        const result = await client.listChannels();
        if (!result.channels || result.channels.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No channels registered.' }] };
        }
        const formatted = result.channels
          .map((ch: any) => `- **${ch.type}** (${ch.name}): ${ch.connected ? 'connected' : 'disconnected'}`)
          .join('\n');
        return { content: [{ type: 'text' as const, text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
