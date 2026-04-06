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
import type { UnifiedMessage, ChannelType, Attachment } from '@/core/types';

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

  // Strip file change / implementation detail sections that are only useful in web UI.
  // Matches sections headed by common technical headers followed by bullet/numbered lists of file paths.
  text = text.replace(/(?:^|\n)#{1,4}\s*(?:files?\s*(?:changed|modified|created|updated|deleted)|changes?\s*(?:made|summary)|implementation\s*details?|what\s*(?:was\s*)?changed)[^\n]*\n(?:[\t ]*[-*\d.].*\n?)+/gi, '');

  // Strip standalone bullet lists where most items look like file paths (contain / or end with common extensions)
  text = text.replace(/(?:^|\n)((?:[\t ]*[-*]\s*`?[\w/.]+(?:\.(?:ts|js|tsx|jsx|py|go|rs|json|yaml|yml|md|css|html|sql))`?[^\n]*\n){3,})/gi, (_match, block: string) => {
    // Only strip if most lines contain path-like content
    const lines = block.trim().split('\n');
    const pathLines = lines.filter(l => /[/\\]|\.(?:ts|js|tsx|jsx|py|go|rs|json|yaml|yml|md|css|html|sql)\b/.test(l));
    return pathLines.length >= lines.length * 0.6 ? '' : _match;
  });

  // Remove excessive whitespace from removals
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // If code was stripped, append a note
  if (codeBlockCount > 0) {
    const plural = codeBlockCount > 1 ? `${codeBlockCount} code blocks` : 'a code block';
    text = text
      ? `${text}\n\n_(Response included ${plural} — view full output in the web UI.)_`
      : `_(Response contained ${plural} — view full output in the web UI.)_`;
  }

  // No hard truncation — let each channel's own message splitting handle long content
  // (e.g., Telegram splits at 4096, Slack at 3000, etc.)

  return text || '_(Response contained only code — view in the web UI.)_';
}

/** Image MIME types that vision models can analyze (after conversion if needed) */
const VISION_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/tiff', 'image/bmp', 'image/avif', 'image/heic', 'image/heif',
  'image/svg+xml', 'image/x-icon',
]);

/** MIME types natively supported by all vision models — no conversion needed */
const NATIVE_VISION_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

/**
 * Analyze image attachments using the vision model and return descriptions.
 * This runs inline so the orchestrator can respond about the image content.
 */
async function analyzeImageAttachments(
  attachments: Attachment[],
  channelType: string,
): Promise<string | null> {
  const images = attachments.filter(a => VISION_MIME_TYPES.has(a.mimeType));
  if (images.length === 0) return null;

  try {
    const { getModelRegistry } = await import('@/models/model-registry');
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const registry = getModelRegistry();
    const visionModel = await registry.getModelForTopic('vision');

    if (!visionModel) {
      channelLogger.warn('No vision model registered (topic: vision). Cannot analyze image attachments.');
      return null;
    }

    const client = getLiteLLMClient();
    const results: string[] = [];

    for (const img of images) {
      try {
        let imageBuffer: Buffer | null = null;

        if (img.data) {
          imageBuffer = Buffer.from(img.data);
        } else if (img.url) {
          const headers: Record<string, string> = {};
          if (channelType === 'slack') {
            const config = getConfig();
            if (config.slack?.botToken) headers['Authorization'] = `Bearer ${config.slack.botToken}`;
          }
          if (channelType === 'whatsapp') {
            const config = getConfig();
            if (config.whatsapp?.accessToken) headers['Authorization'] = `Bearer ${config.whatsapp.accessToken}`;
          }
          const resp = await fetch(img.url, { headers });
          if (!resp.ok) continue;
          imageBuffer = Buffer.from(await resp.arrayBuffer());
        }

        if (!imageBuffer || imageBuffer.length === 0) continue;

        // Convert non-PNG/JPEG formats to PNG for universal vision model compatibility
        let finalBuffer = imageBuffer;
        let finalMime = img.mimeType;
        if (!NATIVE_VISION_MIMES.has(img.mimeType)) {
          try {
            const { execSync } = await import('child_process');
            const tmpIn = `/tmp/vision-input-${Date.now()}`;
            const tmpOut = `/tmp/vision-output-${Date.now()}.png`;
            await Bun.write(tmpIn, imageBuffer);
            execSync(`convert "${tmpIn}" "${tmpOut}"`, { timeout: 10000 });
            const converted = Bun.file(tmpOut);
            finalBuffer = Buffer.from(await converted.arrayBuffer());
            finalMime = 'image/png';
            execSync(`rm -f "${tmpIn}" "${tmpOut}"`, { timeout: 5000 });
          } catch (convErr) {
            channelLogger.warn({ err: convErr, mimeType: img.mimeType }, 'Image conversion failed, sending original format');
          }
        }

        const base64 = finalBuffer.toString('base64');
        const name = img.filename || 'image';

        const result = await client.completeVision({
          model: visionModel.modelId,
          prompt: 'Describe this image in detail. If it contains text, extract and include all text content. If it is a document, receipt, or form, describe its structure and content.',
          imageBase64: base64,
          mimeType: finalMime,
        });

        if (result.content) {
          results.push(`**${name}**: ${result.content}`);
        }
      } catch (imgErr) {
        channelLogger.error({ err: imgErr, filename: img.filename }, 'Failed to analyze image attachment');
      }
    }

    return results.length > 0 ? results.join('\n\n') : null;
  } catch (err) {
    channelLogger.error({ err }, 'Image analysis failed');
    return null;
  }
}

/**
 * Subscribe to document queue completions for a single channel message's attachments.
 * Sends each document's summary back to the channel as it completes.
 */
function subscribeToDocumentResults(
  message: UnifiedMessage,
  umi: import('./interface').UnifiedMessageInterface,
  replyTo?: string,
): void {
  const { getDocumentQueue } = require('@/core/documents/queue') as typeof import('@/core/documents/queue');
  const queue = getDocumentQueue();
  const expectedCount = message.attachments?.length || 0;
  let sent = 0;

  const onCompleted = async (documentId: string, userId?: string) => {
    if (userId && userId !== message.userId) return;

    try {
      const { documentRepository } = await import('@/db/repositories/document-repository');
      const doc = await documentRepository.findById(documentId);
      if (doc && doc.userId === message.userId) {
        const name = doc.originalName || 'Document';
        const summary = doc.summary || doc.ocrText?.slice(0, 500) || 'No content extracted';
        const category = doc.category ? ` [${doc.category}]` : '';
        umi.send(message.channelType, message.channelId, {
          content: `**${name}**${category}\n${summary}`,
          replyTo,
        }).catch(() => {});
        sent++;
      }
    } catch (err) {
      channelLogger.warn({ err, documentId }, 'Failed to fetch document result');
    }

    if (sent >= expectedCount) cleanup();
  };

  const onFailed = (documentId: string, error: string, userId?: string) => {
    if (userId && userId !== message.userId) return;
    sent++;
    umi.send(message.channelType, message.channelId, {
      content: `Document processing failed: ${error}`,
      replyTo,
    }).catch(() => {});
    if (sent >= expectedCount) cleanup();
  };

  const cleanup = () => {
    queue.removeListener('completed', onCompleted);
    queue.removeListener('failed', onFailed);
    clearTimeout(timeout);
  };

  queue.on('completed', onCompleted);
  queue.on('failed', onFailed);

  // Safety timeout
  const timeout = setTimeout(cleanup, 10 * 60 * 1000);
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

    // Send permission request message to the channel — include tool details
    const toolName = request.toolName || request.action || 'unknown';
    const args = request.args as Record<string, unknown> | undefined;
    let detail = '';
    if (args) {
      // Extract the most relevant detail based on tool type
      const path = args.path || args.file_path || args.filename || args.directory;
      const command = args.command;
      const url = args.url;
      const query = args.query;
      const target = args.target || args.channel;
      const message = args.message;

      if (path) {
        detail = `\nFile: ${path}`;
      } else if (command) {
        const cmd = String(command);
        detail = `\nCommand: ${cmd.length > 120 ? cmd.slice(0, 120) + '…' : cmd}`;
      } else if (url) {
        detail = `\nURL: ${url}`;
      } else if (query) {
        detail = `\nQuery: ${query}`;
      } else if (target && message) {
        const msg = String(message);
        detail = `\nTo: ${target}\nMessage: ${msg.length > 100 ? msg.slice(0, 100) + '…' : msg}`;
      }
    }
    try {
      await umi.send(channelType, channelId, {
        content: `🔒 Permission required: the agent wants to use "${toolName}".${detail}\n\nReply "yes" to allow or "no" to deny.`,
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

      const channelSessionId = (message.metadata?.sessionId as string) || `${message.channelType}-${message.channelId}`;

      // Platform-native message ID for reply-to (e.g. Telegram message_id)
      const platformMessageId = message.metadata?.messageId != null
        ? String(message.metadata.messageId)
        : undefined;

      // Resolve the actual DB session ID so we can match orchestrator events
      // (resolveSession converts "telegram-12345" → UUID, and events use the UUID)
      const { resolveSession } = await import('@/core/orchestrator/session-resolver');
      const resolvedSessionId = await resolveSession(channelSessionId, message.userId, message.channelType);

      // Subscribe to orchestrator events for progress feedback via emoji reactions
      const isExternalChannel = message.channelType !== 'webchat';
      let unsubscribe: (() => void) | null = null;
      let unsubAgentEvents: (() => void) | null = null;
      let typingInterval: ReturnType<typeof setInterval> | null = null;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let lastEventTime = Date.now();
      let isTerminal = false;

      const react = (emoji: string) => {
        if (isTerminal) return; // Don't overwrite terminal states
        umi.setReaction(message.channelType, message.channelId, platformMessageId!, emoji).catch(() => {});
      };

      const stopTypingAndStall = () => {
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      };

      const resetStallTimer = () => {
        lastEventTime = Date.now();
        if (stallTimer) clearTimeout(stallTimer);
        if (isTerminal) return;
        // Soft stall at 15s, hard stall at 45s
        stallTimer = setTimeout(() => {
          if (!isTerminal) react('😐'); // soft stall
          stallTimer = setTimeout(() => {
            if (!isTerminal) react('😬'); // hard stall
          }, 30_000);
        }, 15_000);
      };

      if (isExternalChannel && platformMessageId) {
        // Acknowledge receipt with 👀
        react('👀');

        // Repeating typing indicator — Telegram expires after 5s, so resend every 4s
        umi.sendTyping(message.channelType, message.channelId).catch(() => {});
        typingInterval = setInterval(() => {
          if (!isTerminal) {
            umi.sendTyping(message.channelType, message.channelId).catch(() => {});
          }
        }, 4_000);

        // Start stall detection
        resetStallTimer();

        // Role-specific emoji mapping
        const roleEmojis: Record<string, string> = {
          coding: '💻', research: '🔍', writing: '✍️', automation: '⏰',
          review: '🔍', security: '🔒', devops: '🐳', design: '🎨',
          data: '📊', qa: '🧪', orchestrator: '🤔',
        };

        // Subscribe to agent-level events for tool-specific emojis
        const toolEmojis: Record<string, string> = {
          filesystem: '📖', shell: '💻', git: '💻', browser: '🔍',
          websearch: '🔍', knowledge: '📖', docker: '🐳',
          github: '💻', messaging: '💬', scheduling: '⏰', mcp: '🔌',
        };
        try {
          const { getAgentManager } = await import('@/core/agent-manager');
          const agentManager = getAgentManager();
          unsubAgentEvents = agentManager.onEvent((event: any) => {
            if (isTerminal) return;
            // Match events from agents in this session (check multiple possible locations)
            const data = event.data || {};
            const eventSessionId = data.sessionId || event.sessionId || data.context?.sessionId;
            if (eventSessionId !== resolvedSessionId) return;

            if (event.type === 'action') {
              const actionType = data.type || '';
              if (actionType === 'tool_call' || actionType === 'cli_tool_use') {
                resetStallTimer();
                const toolId = data.toolId || '';
                const toolName = data.toolName || '';
                react(toolEmojis[toolId] || toolEmojis[toolName] || '🔧');
              }
            }
            // Keep typing alive on any agent event
            if (event.type === 'thought' || event.type === 'action' || event.type === 'observation') {
              resetStallTimer();
            }
          });
        } catch { /* agent manager not ready */ }

        // Track spawned workers to know when the LAST one completes
        let activeWorkers = 0;
        const sentStatuses = new Set<string>();

        unsubscribe = orchestrator.onEvent((event) => {
          if (event.sessionId !== resolvedSessionId) return;
          resetStallTimer();

          switch (event.type) {
            case 'worker_spawned': {
              const d = event.data as { role?: string; model?: string; workerId?: string };
              const role = d.role === 'orchestrator' ? null : d.role;
              activeWorkers++;

              if (role) {
                react(roleEmojis[role] || '🧠');
                // Send text feedback for non-orchestrator workers (once per role)
                const key = `spawned-${role}`;
                if (!sentStatuses.has(key)) {
                  sentStatuses.add(key);
                  const model = d.model && d.model !== 'direct' ? ` (${d.model})` : '';
                  umi.send(message.channelType, message.channelId, {
                    content: `Working on it \u2014 started *${role}* agent${model}.`,
                    replyTo: platformMessageId,
                  }).catch(() => {});
                }
              } else if (!sentStatuses.has('ack')) {
                sentStatuses.add('ack');
                react('🤔');
              }
              break;
            }
            case 'worker_completed': {
              activeWorkers = Math.max(0, activeWorkers - 1);
              const d = event.data as { status?: string; error?: string; role?: string };
              // Only mark terminal when ALL workers are done
              if (activeWorkers <= 0) {
                isTerminal = true;
                stopTypingAndStall();
                react(d.status === 'failed' || d.error ? '❌' : '✅');
              }
              break;
            }
            case 'team_started': {
              const d = event.data as { members?: Array<{ role: string }> };
              const roles = d.members?.map(m => m.role).join(', ') || 'multiple';
              react('🧠');
              umi.send(message.channelType, message.channelId, {
                content: `Started a team of agents (${roles}).`,
                replyTo: platformMessageId,
              }).catch(() => {});
              break;
            }
            case 'team_completed': {
              isTerminal = true;
              stopTypingAndStall();
              react('✅');
              break;
            }
            case 'approval_required': {
              react('⏳');
              const ad = event.data as { requestId?: string; summary?: string; question?: string; options?: string[] };
              const approvalText = [
                '⏳ **Approval Required**',
                ad.summary || '',
                '',
                ad.question || 'Proceed?',
                ad.options?.length ? `\nOptions: ${ad.options.join(' / ')}` : '',
                '\nReply **yes/approve** to continue, or **no/stop** to cancel.',
              ].filter(Boolean).join('\n');
              umi.send(message.channelType, message.channelId, {
                content: approvalText,
                replyTo: platformMessageId,
              }).catch(() => {});
              break;
            }
            case 'status_update': {
              const d = event.data as { stage?: string; message?: string };
              if (d.stage === 'budget_warning') react('⚠️');
              // Forward pipeline stage updates as text
              if (d.message && d.stage && !sentStatuses.has(`status-${d.stage}`)) {
                sentStatuses.add(`status-${d.stage}`);
                umi.send(message.channelType, message.channelId, {
                  content: d.message,
                  replyTo: platformMessageId,
                }).catch(() => {});
              }
              break;
            }
          }
        });
      }

      // Handle file attachments
      let messageContent = message.content;
      if (message.attachments?.length) {
        const hasImages = message.attachments.some(a => VISION_MIME_TYPES.has(a.mimeType));
        const hasNonImages = message.attachments.some(a => !VISION_MIME_TYPES.has(a.mimeType));
        const hasCaption = messageContent && messageContent.trim().length > 0;

        // All attachments are routed through the document pipeline (fire-and-forget above).
        // For the orchestrator, decide: should we analyze inline or just acknowledge?

        if (!hasCaption) {
          // No caption — pure document upload. Acknowledge and skip orchestrator.
          const attachmentNames = message.attachments.map(a => a.filename || 'file').join(', ');
          await umi.send(message.channelType, message.channelId, {
            content: `Received ${attachmentNames}. Processing through the document pipeline — I'll send you the summary when it's done.`,
            replyTo: platformMessageId,
          });
          // Subscribe to document queue completions to send summary back
          subscribeToDocumentResults(message, umi, platformMessageId);
          if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();
          return;
        }

        if (hasImages && !hasNonImages) {
          // Only images with a caption — analyze with vision model for inline response
          const imageAnalysis = await analyzeImageAttachments(message.attachments, message.channelType);
          if (imageAnalysis) {
            const prefix = `[The user sent image attachment(s). Vision model analysis:\n${imageAnalysis}]\n\n`;
            messageContent = prefix + messageContent;
          }
        } else {
          // Files (possibly mixed with images) + caption — acknowledge, send summaries when done
          const attachmentNames = message.attachments.map(a => a.filename || 'file').join(', ');
          await umi.send(message.channelType, message.channelId, {
            content: `Received ${attachmentNames}. Processing — I'll send you the results when done.`,
            replyTo: platformMessageId,
          });
          subscribeToDocumentResults(message, umi, platformMessageId);
          if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();
          return;
        }
      }

      // Check if session has an active expert (set via /expert command)
      let channelExpertId: string | undefined;
      try {
        const session = await sessionRepository.findById(resolvedSessionId);
        const sessionCtx = session?.context as Record<string, unknown> | undefined;
        if (sessionCtx?.activeExpertId) {
          channelExpertId = sessionCtx.activeExpertId as string;
        }
      } catch { /* ignore — no expert override */ }

      const result = await orchestrator.handleMessage(
        resolvedSessionId,
        message.userId,
        messageContent,
        message.channelType,
        channelExpertId,
      );

      // Unsubscribe from events
      if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();

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
