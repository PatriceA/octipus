export { BaseChannel, UnifiedMessageInterface, getUMI, type ChannelConfig, type ChannelEvents } from './interface';
import { BaseChannel } from './interface';
export { TelegramChannel, telegramChannel } from './telegram';
export { SlackChannel, slackChannel } from './slack';
export { TeamsChannel, teamsChannel } from './teams';
export { WebChatChannel, webChatChannel, type WebChatConnection, type WebChatMessage } from './webchat';

import { getUMI } from './interface';
import { telegramChannel } from './telegram';
import { slackChannel } from './slack';
import { teamsChannel } from './teams';
import { webChatChannel } from './webchat';
import { getConfig } from '@/config';
import { channelLogger } from '@/utils/logger';
import { getPermissionManager } from '@/security/permissions';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { UnifiedMessage, ChannelType } from '@/core/types';

/**
 * Track pending permission requests per user for channel-based approval.
 * Maps userId → { requestId, channelType, channelId }
 */
const pendingChannelPermissions = new Map<string, {
  requestId: string;
  channelType: ChannelType;
  channelId: string;
}>();

/**
 * Check if a message is a yes/no reply to a pending permission request.
 * Returns true if the message was consumed as a permission response.
 */
async function tryResolvePermissionFromChannel(message: UnifiedMessage): Promise<boolean> {
  const pending = pendingChannelPermissions.get(message.userId);
  if (!pending) return false;

  const normalized = message.content.trim().toLowerCase();
  const isYes = /^(yes|y|approve|allow|go|ok|sure|ja|confirm)\b/i.test(normalized);
  const isNo = /^(no|n|deny|reject|stop|cancel|nein|abort)\b/i.test(normalized);

  if (!isYes && !isNo) return false;

  const permissionManager = getPermissionManager();
  pendingChannelPermissions.delete(message.userId);

  const umi = getUMI();
  if (isYes) {
    await permissionManager.approve(pending.requestId, message.userId);
    try {
      await umi.send(pending.channelType, pending.channelId, {
        content: 'Permission granted. Continuing...',
      });
    } catch { /* ignore */ }
  } else {
    await permissionManager.deny(pending.requestId, message.userId);
    try {
      await umi.send(pending.channelType, pending.channelId, {
        content: 'Permission denied.',
      });
    } catch { /* ignore */ }
  }

  return true;
}

/**
 * Reinitialize a single channel at runtime (hot-reload).
 * Disconnects, unregisters, then re-registers and reconnects if configured.
 */
export async function reinitializeChannel(channelType: ChannelType): Promise<void> {
  const umi = getUMI();
  const config = getConfig();

  // Disconnect and unregister existing
  const existing = umi.getChannel(channelType);
  if (existing) {
    try {
      await existing.disconnect();
    } catch (error) {
      channelLogger.warn({ error, channelType }, 'Error disconnecting channel during reinit');
    }
    umi.unregister(channelType);
  }

  // Create fresh instance and register if configured
  let newChannel: BaseChannel | null = null;
  switch (channelType) {
    case 'telegram':
      if (config.telegram?.botToken) {
        // Create new instance to avoid stale state
        const { TelegramChannel } = await import('./telegram');
        newChannel = new TelegramChannel();
      }
      break;
    case 'slack':
      if (config.slack?.botToken) {
        const { SlackChannel } = await import('./slack');
        newChannel = new SlackChannel();
      }
      break;
    case 'teams':
      if (config.teams?.appId) {
        const { TeamsChannel } = await import('./teams');
        newChannel = new TeamsChannel();
      }
      break;
    default:
      channelLogger.warn({ channelType }, 'Cannot reinitialize channel type');
      return;
  }

  if (newChannel) {
    umi.register(newChannel);
    try {
      await newChannel.connect();
      channelLogger.info({ channelType }, 'Channel reinitialized successfully');
    } catch (error) {
      channelLogger.error({ error, channelType }, 'Failed to reconnect channel during reinit');
    }
  } else {
    channelLogger.info({ channelType }, 'Channel removed (no longer configured)');
  }
}

/**
 * Initialize and register all configured channels
 */
export async function initializeChannels(): Promise<void> {
  const umi = getUMI();
  const config = getConfig();

  // Always register webchat
  umi.register(webChatChannel);

  // Register Telegram if configured
  if (config.telegram?.botToken) {
    umi.register(telegramChannel);
  }

  // Register Slack if configured
  if (config.slack?.botToken) {
    umi.register(slackChannel);
  }

  // Register Teams if configured
  if (config.teams?.appId) {
    umi.register(teamsChannel);
  }

  // Connect all registered channels
  await umi.connectAll();

  // Subscribe to permission requests and forward them to the originating channel
  const permissionManager = getPermissionManager();
  permissionManager.onRequest(async (request: Record<string, unknown>) => {
    const userId = request.userId as string;
    const sessionId = request.sessionId as string;
    if (!userId || !sessionId) return;

    // Look up the session to find which channel originated it
    const session = await sessionRepository.findById(sessionId);
    if (!session || !session.channelType || session.channelType === 'webchat') return;

    const channelType = session.channelType as ChannelType;
    const channelId = session.channelId;
    if (!channelId) return;

    // Track this pending permission for the user
    pendingChannelPermissions.set(userId, {
      requestId: request.requestId as string,
      channelType,
      channelId,
    });

    // Send permission request message to the channel
    const toolName = request.toolName || request.action || 'unknown';
    try {
      await umi.send(channelType, channelId, {
        content: `Permission required: the agent wants to use "${toolName}".\n\nReply "yes" to allow or "no" to deny.`,
      });
    } catch (error) {
      channelLogger.error({ error, channelType }, 'Failed to forward permission request to channel');
    }
  });

  // Bridge incoming channel messages → orchestrator → reply
  umi.on('message', async (message: UnifiedMessage) => {
    try {
      // Check if this is a yes/no reply to a pending permission request
      const consumed = await tryResolvePermissionFromChannel(message);
      if (consumed) return;

      const { getOrchestratorService } = await import('@/core/orchestrator');
      const orchestrator = getOrchestratorService();

      const sessionId = (message.metadata?.sessionId as string) || `${message.channelType}-${message.channelId}`;
      const result = await orchestrator.handleMessage(
        sessionId,
        message.userId,
        message.content,
        message.channelType,
      );

      // Send reply back through the same channel
      // Use the platform-native message ID for reply-to (e.g. Telegram message_id)
      const platformMessageId = message.metadata?.messageId != null
        ? String(message.metadata.messageId)
        : undefined;

      if (result.response) {
        await umi.send(message.channelType, message.channelId, {
          content: result.response,
          replyTo: platformMessageId,
        });
      }
    } catch (error) {
      channelLogger.error({ error, channelType: message.channelType }, 'Failed to process channel message');
      // Try to send error feedback to the user (without reply-to to avoid cascading failures)
      try {
        await umi.send(message.channelType, message.channelId, {
          content: 'Sorry, I encountered an error processing your message. Please try again later.',
        });
      } catch {
        // Ignore send failure — channel may be disconnected
      }
    }
  });
}
