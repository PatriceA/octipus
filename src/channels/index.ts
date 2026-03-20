export { BaseChannel, UnifiedMessageInterface, getUMI, type ChannelConfig, type ChannelEvents } from './interface';
import { BaseChannel } from './interface';
export { TelegramChannel, telegramChannel } from './telegram';
export { SlackChannel, slackChannel } from './slack';
export { TeamsChannel, teamsChannel } from './teams';
export { WhatsAppChannel, whatsappChannel } from './whatsapp';
export { WebChatChannel, webChatChannel, type WebChatConnection, type WebChatMessage } from './webchat';

import { getUMI } from './interface';
import { telegramChannel } from './telegram';
import { slackChannel } from './slack';
import { teamsChannel } from './teams';
import { whatsappChannel } from './whatsapp';
import { webChatChannel } from './webchat';
import { getConfig } from '@/config';
import { channelLogger } from '@/utils/logger';
import { getPermissionManager } from '@/security/permissions';
import { sessionRepository } from '@/db/repositories/session-repository';
import { processChannelAttachments } from './attachment-handler';
import type { UnifiedMessage, ChannelType } from '@/core/types';

/**
 * Summarize a response for external channels (Telegram, Slack, etc.).
 * Strips code blocks, thinking sections, and long outputs — sends a concise summary.
 */
function summarizeForChannel(response: string): string {
  let text = response;

  // Remove <think>...</think> or <thinking>...</thinking> blocks
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');

  // Replace code blocks with a short placeholder
  const codeBlockCount = (text.match(/```[\s\S]*?```/g) || []).length;
  text = text.replace(/```[\s\S]*?```/g, '');

  // Remove excessive whitespace from removals
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // If code was stripped, append a note
  if (codeBlockCount > 0) {
    const plural = codeBlockCount > 1 ? `${codeBlockCount} code blocks` : 'a code block';
    text = text
      ? `${text}\n\n_(Response included ${plural} — view full output in the web UI.)_`
      : `_(Response contained ${plural} — view full output in the web UI.)_`;
  }

  // Truncate if still too long (keep under 3000 chars for readability)
  if (text.length > 3000) {
    text = text.slice(0, 2900) + '\n\n_(Truncated — view full response in the web UI.)_';
  }

  return text || '_(Response contained only code — view in the web UI.)_';
}

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
    case 'whatsapp':
      if (config.whatsapp?.accessToken) {
        const { WhatsAppChannel } = await import('./whatsapp');
        newChannel = new WhatsAppChannel();
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

  // Register WhatsApp if configured
  if (config.whatsapp?.accessToken) {
    umi.register(whatsappChannel);
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

      // Process file attachments → document OCR pipeline (fire-and-forget)
      if (message.attachments?.length) {
        processChannelAttachments(message).catch((err) => {
          channelLogger.error({ err, channelType: message.channelType }, 'Attachment processing failed');
        });
      }

      const { getOrchestratorService } = await import('@/core/orchestrator');
      const orchestrator = getOrchestratorService();

      const sessionId = (message.metadata?.sessionId as string) || `${message.channelType}-${message.channelId}`;

      // Platform-native message ID for reply-to (e.g. Telegram message_id)
      const platformMessageId = message.metadata?.messageId != null
        ? String(message.metadata.messageId)
        : undefined;

      // Subscribe to orchestrator events for progress feedback on non-webchat channels
      const isExternalChannel = message.channelType !== 'webchat';
      let unsubscribe: (() => void) | null = null;
      const sentStatuses = new Set<string>();

      if (isExternalChannel) {
        unsubscribe = orchestrator.onEvent((event) => {
          if (event.sessionId !== sessionId) return;

          let statusMsg: string | null = null;

          switch (event.type) {
            case 'worker_spawned': {
              const d = event.data as { role?: string; workerId?: string };
              const role = d.role === 'orchestrator' ? null : d.role;
              if (role) {
                const key = `spawned-${role}`;
                if (!sentStatuses.has(key)) {
                  sentStatuses.add(key);
                  statusMsg = `Working on it — started a *${role}* agent.`;
                }
              } else if (!sentStatuses.has('ack')) {
                sentStatuses.add('ack');
                statusMsg = 'Got it, working on it.';
              }
              break;
            }
            case 'team_started': {
              const d = event.data as { members?: Array<{ role: string }> };
              const roles = d.members?.map(m => m.role).join(', ') || 'multiple';
              statusMsg = `Started a team of agents (${roles}), waiting for results.`;
              break;
            }
            case 'status_update': {
              const d = event.data as { message?: string; stage?: string };
              if (d.message && d.stage === 'budget_warning') {
                statusMsg = d.message;
              }
              break;
            }
          }

          if (statusMsg) {
            umi.send(message.channelType, message.channelId, {
              content: statusMsg,
              replyTo: platformMessageId,
            }).catch(() => {});
          }
        });
      }

      // Inject attachment context so the model knows files were sent
      let messageContent = message.content;
      if (message.attachments?.length) {
        const attachmentDescriptions = message.attachments.map(a => {
          const name = a.filename || `${a.type} file`;
          const size = a.size ? ` (${(a.size / 1024).toFixed(1)}KB)` : '';
          return `- ${name} [${a.mimeType}]${size}`;
        }).join('\n');
        const prefix = `[The user sent ${message.attachments.length} file attachment${message.attachments.length > 1 ? 's' : ''} which ${message.attachments.length > 1 ? 'are' : 'is'} being processed by the document pipeline:\n${attachmentDescriptions}]\n\n`;
        messageContent = prefix + (messageContent || 'What is this file?');
      }

      const result = await orchestrator.handleMessage(
        sessionId,
        message.userId,
        messageContent,
        message.channelType,
      );

      // Unsubscribe from events
      if (unsubscribe) unsubscribe();

      // Send final reply back through the same channel
      if (result.response) {
        const content = isExternalChannel
          ? summarizeForChannel(result.response)
          : result.response;

        await umi.send(message.channelType, message.channelId, {
          content,
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
