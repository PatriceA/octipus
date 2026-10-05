export { BaseChannel, type ChannelConfig, type ChannelEvents, getUMI, UnifiedMessageInterface } from './interface';

import { coreLogger } from '@/utils/logger';

export { SlackChannel, slackChannel } from './slack';
export { TeamsChannel, teamsChannel } from './teams';
export { TelegramChannel, telegramChannel } from './telegram';
export { WebChatChannel, webChatChannel } from './webchat';
export { WhatsAppChannel, whatsappChannel } from './whatsapp';

import { getConfig } from '@/config';
import { sharedRefusalText } from '@/core/errors/limit-refusal';
import { recordChannelMessage } from '@/core/telemetry';
import type { Attachment, ChannelType, UnifiedMessage } from '@/core/types';
import type { GroupChannel } from '@/db/schema/group-channels';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getPermissionManager, type PermissionRequestEvent } from '@/security/permissions';
import { channelLogger } from '@/utils/logger';
import { attendChat, newestApprovalPostedAt, startApprovalPrompts, tryResolveApprovalFromChannel } from './approval-prompts';
import { processChannelAttachments } from './attachment-handler';
import { startTakenWork, type TakenWork, takeRequestOf } from './take-work';
import { startTakenTaskNotices } from './taken-task-notices';
import { answerHow } from './group-handler';
import { getUMI } from './interface';
import { fileAt, writeFileAt } from '@/utils/fs-file';
import { whichSync } from '@/utils/proc';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ImageMagick binary for vision-input conversion, or null. IM7 ships `magick`;
 * bare `convert` is only trusted off Windows, where `convert` on PATH is
 * System32's FAT-to-NTFS disk converter.
 */
export function imageConverter(platform = process.platform, find: (bin: string) => string | null = whichSync): string | null {
  return find('magick') ?? (platform === 'win32' ? null : 'convert');
}

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
 * This runs inline so the root agent can respond about the image content.
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
          const converter = imageConverter();
          const tmpIn = join(tmpdir(), `vision-input-${Date.now()}`);
          const tmpOut = join(tmpdir(), `vision-output-${Date.now()}.png`);
          try {
            if (!converter) throw new Error('ImageMagick not found (install it so `magick` is on PATH)');
            await writeFileAt(tmpIn, imageBuffer);
            // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- array-form, no shell; converter is magick/convert, args are our own temp paths
            execFileSync(converter, [tmpIn, tmpOut], { timeout: 10000, windowsHide: true });
            const converted = fileAt(tmpOut);
            finalBuffer = Buffer.from(await converted.arrayBuffer());
            finalMime = 'image/png';
          } catch (convErr) {
            channelLogger.warn({ err: convErr, mimeType: img.mimeType }, 'Image conversion failed, sending original format');
          } finally {
            rmSync(tmpIn, { force: true });
            rmSync(tmpOut, { force: true });
          }
        }

        const base64 = finalBuffer.toString('base64');
        const name = img.filename || 'image';

        const result = await client.completeVision({
          model: visionModel.modelId,
          modelConfigName: visionModel.name,
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

/** An audio attachment is a voice note by type or MIME (all channels build these identically). */
function isAudioAttachment(a: Attachment): boolean {
  // mimeType is typed as required but Teams passes through a possibly-undefined
  // contentType, so guard the deref (the old VISION_MIME_TYPES.has path was safe).
  return a.type === 'audio' || !!a.mimeType?.startsWith('audio/');
}

/**
 * Download inbound voice-note bytes and transcribe them to text so the utterance
 * reaches the root agent like any typed message. Reuses the channel-aware
 * downloader (Slack/WhatsApp auth headers) and the default STT engine order
 * (local whisper.cpp → Mistral → OpenAI). Returns '' if nothing transcribed.
 */
async function transcribeChannelAudio(audioAttachments: Attachment[], message: UnifiedMessage): Promise<string> {
  const { downloadAttachment } = await import('./attachment-handler');
  const { transcribeAudioBuffer } = await import('@/voice/stt');
  const parts: string[] = [];
  for (const att of audioAttachments) {
    try {
      const buf = await downloadAttachment(att, message);
      if (!buf?.length) continue;
      const ext = (att.mimeType.split('/')[1] || 'ogg').split(';')[0];
      const text = (await transcribeAudioBuffer(buf, ext)).trim();
      if (text) parts.push(text);
    } catch (err) {
      channelLogger.error({ err, channel: message.channelType }, 'Voice note transcription failed');
    }
  }
  return parts.join('\n\n');
}

/**
 * Synthesize an assistant reply to a spoken clip so a voice note gets a voice
 * reply. Best-effort: gated on `voice.ttsEnabled`, and any synthesis failure is
 * swallowed (undefined → the text reply still goes out on its own).
 * ponytail: Telegram-only for now; other channels' outbound audio senders take a
 * URL, not bytes. Cap the text so long/costly replies aren't fully synthesized.
 */
async function synthesizeVoiceReply(text: string): Promise<Attachment[] | undefined> {
  const config = getConfig();
  if (!config.voice.ttsEnabled) return undefined;
  try {
    const provider = config.voice.ttsProvider;
    // Each engine's real output format (piper hardcodes wav; mistral/openai
    // honour the request) — so the extension always matches the bytes.
    const ext = ({ piper: 'wav', kokoro: 'wav', mistral: 'mp3', openai: 'mp3' } as Record<string, string>)[provider] || 'mp3';
    const { createTTSEngine } = await import('@/voice/tts');
    const engine = createTTSEngine(provider, undefined, { outputFormat: ext as 'wav' | 'mp3' });
    const audio = await engine.synthesize(text.slice(0, 2000));
    return [{
      type: 'audio',
      mimeType: ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`,
      data: Buffer.from(audio),
      filename: `reply.${ext}`,
    }];
  } catch (err) {
    channelLogger.error({ err }, 'Voice-out synthesis failed');
    return undefined;
  }
}

/**
 * Subscribe to document queue completions for a single channel message's attachments.
 * Sends each document's summary back to the channel as it completes.
 */
export function subscribeToDocumentResults(
  message: UnifiedMessage,
  umi: import('./interface').UnifiedMessageInterface,
  /**
   * The documents this message's attachments became. Only their results are
   * reported here: another document of the same user finishing meanwhile
   * (a DM upload, the web app) must never be summarised into this chat —
   * least of all into a group thread.
   */
  documentIds: Promise<string[]>,
  replyTo?: string,
  /** Group channels: summaries go into the member's thread, not the channel. */
  threadId?: string,
  /** Test seam: the queue to listen on. */
  queue: Pick<import('node:events').EventEmitter, 'on' | 'removeListener'> =
    (require('@/core/documents/queue') as typeof import('@/core/documents/queue')).getDocumentQueue(),
): void {
  let sent = 0;
  // Each document is reported once, whether by its event or by the status
  // check below for one that finished before the listeners were attached.
  const reported = new Set<string>();
  const ours = async (documentId: string) => {
    const ids = await documentIds;
    // Check and mark with no await in between, so two reports cannot both pass.
    if (!ids.includes(documentId) || reported.has(documentId)) return false;
    reported.add(documentId);
    return true;
  };

  const onCompleted = async (documentId: string, userId?: string) => {
    if (userId && userId !== message.userId) return;
    if (!(await ours(documentId))) return;
    sent++; // counted whether or not the row can still be read, so cleanup always happens

    try {
      const { documentRepository } = await import('@/db/repositories/document-repository');
      const doc = await documentRepository.findByIdSystem(documentId);
      if (doc && doc.userId === message.userId) {
        const name = doc.originalName || 'Document';
        const summary = doc.summary || doc.ocrText?.slice(0, 500) || 'No content extracted';
        const category = doc.category ? ` [${doc.category}]` : '';
        umi.send(message.channelType, message.channelId, {
          content: `**${name}**${category}\n${summary}`,
          replyTo,
          threadId,
        }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
      }
    } catch (err) {
      channelLogger.warn({ err, documentId }, 'Failed to fetch document result');
    }

    if (sent >= (await documentIds).length) cleanup();
  };

  const onFailed = async (documentId: string, error: string, userId?: string) => {
    if (userId && userId !== message.userId) return;
    if (!(await ours(documentId))) return;
    sent++;
    umi.send(message.channelType, message.channelId, {
      content: `Document processing failed: ${error}`,
      replyTo,
      threadId,
    }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
    if (sent >= (await documentIds).length) cleanup();
  };

  const cleanup = () => {
    queue.removeListener('completed', onCompleted);
    queue.removeListener('failed', onFailed);
    clearTimeout(timeout);
  };

  queue.on('completed', onCompleted);
  queue.on('failed', onFailed);

  // Nothing was enqueued (download failed, nothing processable): say so now
  // instead of leaving the "I'll send you the summary" promise hanging. And a
  // document may already have finished before the listeners above were
  // attached (processing starts before this subscription): report those from
  // their stored status.
  void documentIds.then(async (ids) => {
    if (ids.length > 0) {
      const { documentRepository } = await import('@/db/repositories/document-repository');
      for (const id of ids) {
        const doc = await documentRepository.findByIdSystem(id).catch(() => null);
        if (doc?.status === 'completed') await onCompleted(id, message.userId);
        else if (doc?.status === 'failed') await onFailed(id, 'processing failed', message.userId);
      }
      return;
    }
    cleanup();
    umi.send(message.channelType, message.channelId, {
      content: 'I could not process that attachment (download failed or the file type is not supported).',
      replyTo,
      threadId,
    }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
  });

  // Safety timeout
  const timeout = setTimeout(cleanup, 10 * 60 * 1000);
}

interface PendingChannelPermission {
  requestId: string;
  channelType: ChannelType;
  channelId: string;
  /** Group channels only: the thread the prompt was posted in. */
  threadId?: string;
  /** Named in the confirmation, so the user sees what their reply decided. */
  toolName: string;
  /**
   * Set once the prompt has been posted. Until then a reply cannot answer it:
   * a "yes" typed for the prompt on screen must not approve a newer request
   * whose prompt the user has not seen yet.
   */
  announced: boolean;
  /** When it was posted (ms): a reply answers the newest prompt, permission or approval. */
  announcedAt?: number;
}

/**
 * Pending permission prompts awaiting a "yes"/"no" typed in a chat. Keyed by
 * the user AND the chat (plus the thread, for a group channel): a reply only
 * answers prompts asked of that user in that place, so another member's
 * "yes" never counts, and prompts waiting in two threads (or a thread and a
 * DM) do not displace each other. A reply answers the NEWEST prompt for its
 * key — the one on screen — and the confirmation names its tool. Entries are
 * dropped when the permission manager resolves them by any route (web UI,
 * expiry; `forgetResolvedChannelPermission`), so queues do not grow.
 */
const pendingChannelPermissions = new Map<string, PendingChannelPermission[]>();

function pendingKey(userId: string, channelType: string, channelId: string, threadId?: string): string {
  return [userId, channelType, channelId, threadId ?? ''].join('\u0000');
}

/**
 * Requests resolved before their prompt was recorded (the forwarder awaits a
 * session lookup first): they must not be queued afterwards.
 */
const recentlyResolved = new Set<string>();

/** Test seam. */
export function _resetPendingChannelPermissionsForTests(): void {
  pendingChannelPermissions.clear();
  recentlyResolved.clear();
}

function removePending(key: string, requestId: string): void {
  const queue = (pendingChannelPermissions.get(key) ?? []).filter(p => p.requestId !== requestId);
  if (queue.length > 0) pendingChannelPermissions.set(key, queue);
  else pendingChannelPermissions.delete(key);
}

/**
 * `PermissionManager.onResolved` listener: a prompt answered in the web UI,
 * expired or released is no longer waiting for a typed reply.
 */
export function forgetResolvedChannelPermission(event: { userId: string; requestId: string }): void {
  recentlyResolved.delete(event.requestId);
  recentlyResolved.add(event.requestId);
  if (recentlyResolved.size > 1_000) recentlyResolved.delete(recentlyResolved.values().next().value as string);
  const prefix = `${event.userId}\u0000`;
  for (const key of [...pendingChannelPermissions.keys()]) {
    if (key.startsWith(prefix)) removePending(key, event.requestId);
  }
}

/**
 * Check if a message is a yes/no reply to a pending permission request.
 * Returns true if the message was consumed as a permission response.
 */
/**
 * Octipus session id an agent event belongs to. `data.sessionId` is NOT used
 * here — for CLI thought events that field is a vendor (Claude/Codex) session
 * id, which would never match octipus's own resolved session id.
 */
export function eventSessionId(event: { sessionId?: string; data?: { context?: { sessionId?: string }; [key: string]: unknown } }): string | undefined {
  return event.sessionId || event.data?.context?.sessionId;
}

/** The key a reply in this chat (and group thread) is looked up under. */
function replyPendingKey(message: UnifiedMessage): string {
  const groupThread = typeof message.metadata?.groupChannelId === 'string' ? message.threadId : undefined;
  return pendingKey(message.userId, message.channelType, message.channelId, groupThread);
}

/** When the newest permission prompt waiting in this chat for this user was posted (ms), or 0. */
function newestPermissionPromptAt(message: UnifiedMessage): number {
  return pendingChannelPermissions.get(replyPendingKey(message))?.filter(p => p.announced).at(-1)?.announcedAt ?? 0;
}

/**
 * A typed yes/no for a prompt posted in this chat: a permission request or
 * an agent approval. The NEWER of the two is answered first — the one on
 * screen — and the other only if the reply does not answer that one.
 * Returns true when the message was consumed.
 */
export async function tryResolvePromptReply(message: UnifiedMessage): Promise<boolean> {
  const attempts = await newestApprovalPostedAt(message) > newestPermissionPromptAt(message)
    ? [tryResolveApprovalFromChannel, tryResolvePermissionFromChannel]
    : [tryResolvePermissionFromChannel, tryResolveApprovalFromChannel];
  for (const attempt of attempts) {
    if (await attempt(message)) return true;
  }
  return false;
}

/** Exported for the regression test that pins the per-chat / per-thread scoping. */
export async function tryResolvePermissionFromChannel(message: UnifiedMessage): Promise<boolean> {
  // A message with a file is something to work on, not an answer.
  if (message.attachments?.length) return false;
  const groupThread = typeof message.metadata?.groupChannelId === 'string' ? message.threadId : undefined;
  const key = replyPendingKey(message);
  const pending = pendingChannelPermissions.get(key)?.filter(p => p.announced).at(-1);
  if (!pending) return false;

  // In a group thread the requester also talks to colleagues ("ok, I'll ask
  // Dana first"), so only a bare yes/no answers there. A 1:1 chat keeps the
  // looser prefix match.
  let answer: 'yes' | 'no' | null;
  if (groupThread) {
    const { bareReply } = await import('@/core/channels/group-context');
    answer = bareReply(message.content);
  } else {
    const normalized = message.content.trim().toLowerCase();
    answer = /^(yes|y|approve|allow|go|ok|sure|ja|confirm)\b/i.test(normalized) ? 'yes'
      : /^(no|n|deny|reject|stop|cancel|nein|abort)\b/i.test(normalized) ? 'no'
      : null;
  }
  if (!answer) return false;

  // Only the newest prompt — the one the user is looking at — is answered.
  // The entry is dropped only after a definite result: if approve/deny
  // throws, it stays so the user can retry.
  const permissionManager = getPermissionManager();
  const resolved = answer === 'yes'
    ? await permissionManager.approve(pending.requestId, message.userId)
    : await permissionManager.deny(pending.requestId, message.userId);
  removePending(key, pending.requestId);

  const stillWaiting = pendingChannelPermissions.get(key)?.filter(p => p.announced).length ?? 0;
  const more = stillWaiting > 0 ? ` (${stillWaiting} more permission request${stillWaiting === 1 ? '' : 's'} waiting.)` : '';
  // Never let a reply meant for one prompt fall through to an older one.
  const content = !resolved
    ? `That permission request for "${pending.toolName}" was already answered elsewhere or has expired; nothing was changed.${more}`
    : answer === 'yes'
      ? `Permission granted for "${pending.toolName}". Continuing...${more}`
      : `Permission denied for "${pending.toolName}".${more}`;
  try {
    await getUMI().send(pending.channelType, pending.channelId, { content, threadId: pending.threadId });
  } catch (err) {
    channelLogger.warn({ err, channelType: pending.channelType }, 'Could not confirm a permission reply in the chat');
  }
  return true;
}

/**
 * Reinitialize a single channel at runtime (hot-reload).
 * Disconnects, unregisters, then re-registers and reconnects if the
 * channel's `isEnabled(config)` still returns true. Drives off discovery —
 * no per-channel switch.
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

  const { discoverChannels } = await import('./discovery');
  const discovered = await discoverChannels();
  const match = discovered.find(d => d.channel.type === channelType);
  if (!match) {
    channelLogger.warn({ channelType }, 'Cannot reinitialize: no matching channel discovered');
    return;
  }
  if (!match.channel.isEnabled(config)) {
    channelLogger.info({ channelType }, 'Channel removed (no longer configured)');
    return;
  }

  umi.register(match.channel);
  try {
    await match.channel.connect();
    channelLogger.info({ channelType }, 'Channel reinitialized successfully');
  } catch (error) {
    channelLogger.error({ error, channelType }, 'Failed to reconnect channel during reinit');
  }
}

/** Channel types a human can actually be prompted on. */
const MESSAGING_CHANNELS: ReadonlySet<string> = new Set<ChannelType>([
  'telegram', 'teams', 'slack', 'whatsapp',
]);

/**
 * Forward an ASK-level permission request to the messaging channel the
 * session came from. Exported for the regression test that pins the
 * non-messaging guard below.
 */
export async function forwardPermissionRequestToChannel(request: PermissionRequestEvent): Promise<void> {
  const umi = getUMI();
  const permissionManager = getPermissionManager();
  const userId = request.userId;
  const sessionId = request.sessionId;
  if (!userId || !sessionId) return;

  // Look up the session to find which channel originated it
  const session = await sessionRepository.findById(sessionId);
  // Only a messaging channel can carry a permission prompt. Non-messaging
  // sessions have a channelType too ('tui', 'webchat', 'api'), and the old
  // `!== 'webchat'` test let 'tui' through to `umi.send`, which throws for a
  // type no channel is registered for — the catch below then DENIED the
  // request within milliseconds, so the prompt the TUI user was looking at
  // was already resolved before they could answer it. Keyed on the type, not
  // on registration: a Slack session whose channel is currently down must
  // still reach the deny branch rather than stall for the whole TTL.
  if (!session?.channelType || !MESSAGING_CHANNELS.has(session.channelType)) return;

  const channelType = session.channelType as ChannelType;
  const channelId = session.channelId;
  if (!channelId) return;

  // A group-channel session asks in its thread — but only while the channel
  // is enrolled and active: after `leave` or a pause the bot stays silent
  // there, and the request is denied (see below).
  if (session.groupChannelId) {
    const { findGroupChannel, isGroupChannelActive } = await import('./group-channels');
    const group = await findGroupChannel(channelType, channelId);
    if (group?.id !== session.groupChannelId || !(await isGroupChannelActive(group))) {
      // Not posted: the bot is silent in a removed or paused channel. Denied,
      // not left pending: permission requests do not expire, so nothing would
      // ever release the turn (and the session lock it holds).
      channelLogger.info({ sessionId, channelId }, 'Permission request from a group thread whose channel is removed or paused — denying it');
      await permissionManager
        .deny(request.requestId, userId, 'the group channel this conversation belongs to was removed or is paused')
        .catch((err: unknown) => channelLogger.error({ err }, 'Failed to deny a permission request for a removed group channel'));
      return;
    }
  }
  if (recentlyResolved.has(request.requestId)) return;
  const threadId = session.groupChannelId ? session.threadId ?? undefined : undefined;
  const key = pendingKey(userId, channelType, channelId, threadId);

  // Send permission request message to the channel — include tool details
  const toolName = request.toolName || request.action || 'unknown';

  // Track this pending permission for the user, in this chat (and thread)
  pendingChannelPermissions.set(key, [
    ...(pendingChannelPermissions.get(key) ?? []),
    { requestId: request.requestId, channelType, channelId, threadId, toolName, announced: false },
  ]);
  const announce = () => {
    const entry = pendingChannelPermissions.get(key)?.find(p => p.requestId === request.requestId);
    if (entry) {
      entry.announced = true;
      entry.announcedAt = Date.now();
    }
  };
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
  const fullPrompt = `🔒 Permission required: the agent wants to use "${toolName}".${detail}\n\nReply "yes" to allow or "no" to deny.`;
  try {
    if (session.groupChannelId) {
      // Everyone in the channel reads the thread, and the tool arguments are
      // the requester's (a file path, a command, an email body). Only the
      // requester sees them; the thread gets a prompt without details.
      const { userRepository } = await import('@/db/repositories/user-repository');
      const name = (await userRepository.findById(userId))?.username ?? 'The requester';
      const shownPrivately = await umi.sendPrivate(channelType, channelId, userId, {
        content: `🔒 Permission required: the agent wants to use "${toolName}".${detail}\n\nReply "yes" or "no" ${answerHow(channelType, threadId)}.`,
        threadId,
      }).catch((err: unknown) => {
        channelLogger.warn({ err, channelType }, 'Private permission details could not be delivered');
        return false;
      });
      // Answered in the web app while the details were going out: say nothing more.
      if (recentlyResolved.has(request.requestId)) return;
      const where = shownPrivately
        ? 'I sent you the details privately; only you can see them.'
        : 'I could not show you the details privately here; check the request in the Octipus web app, or reply "no".';
      await umi.send(channelType, channelId, {
        content: `🔒 ${name}: Octipus needs your permission to use "${toolName}". ${where}\n\nOnly ${name} can reply "yes" to allow or "no" to deny, ${answerHow(channelType, threadId)}.`,
        threadId,
      });
    } else {
      await umi.send(channelType, channelId, { content: fullPrompt });
    }
    announce();
  } catch (error) {
    // The prompt never reached a human, so leaving the request pending buys
    // nothing but a stall until it expires — the run blocks for the whole TTL
    // and then fails anyway. Deny it now, with the delivery failure as the
    // reason, so the agent gets an answer it can report.
    channelLogger.error({ error, channelType }, 'Failed to forward permission request to channel — denying it');
    // Remove only OUR entry: other prompts queued for this chat stay answerable.
    removePending(key, request.requestId);
    await permissionManager
      .deny(request.requestId, userId, `could not be delivered to the ${channelType} channel`)
      .catch((denyError) => {
        channelLogger.error({ denyError, channelType }, 'Failed to deny an undeliverable permission request');
      });
  }
}

/**
 * The acting member's own session for a group-channel thread. The adapter
 * only tags messages from enrolled channels; re-check here so a stale or
 * forged tag cannot attach a turn to another chat's enrolment.
 */
async function resolveGroupTurnSession(message: UnifiedMessage, groupChannelId: string): Promise<{ sessionId: string; group: GroupChannel }> {
  const { findGroupChannel, resolveGroupSession } = await import('./group-channels');
  const group = await findGroupChannel(message.channelType, message.channelId);
  if (!group || group.id !== groupChannelId) throw new Error('Group channel enrolment not found for this chat');
  if (!message.threadId) throw new Error('Group channel message without a thread');
  const sessionId = await resolveGroupSession({
    userId: message.userId,
    group,
    threadId: message.threadId,
    title: message.content.slice(0, 80).replace(/\n/g, ' ').trim() || undefined,
  });
  // The flow guard's shared-audience mark is set by AgentService.handleMessage
  // from the stored session, for every entry point.
  return { sessionId, group };
}

/**
 * Initialize and register all configured channels via auto-discovery.
 * Each channel decides whether it should be enabled via its own
 * `isEnabled(config)` method — no per-channel switch here.
 */
export async function initializeChannels(): Promise<void> {
  const umi = getUMI();
  const config = getConfig();

  const { discoverChannels } = await import('./discovery');
  const discovered = await discoverChannels();
  const enabled = discovered.filter((d) => d.channel.isEnabled(config));
  const skipped = discovered.filter((d) => !d.channel.isEnabled(config));
  for (const { folder, channel } of enabled) {
    umi.register(channel);
    channelLogger.debug({ folder, type: channel.type }, 'Channel registered (auto-discovered)');
  }
  // Surface skipped channels at info level. A channel is skipped when its
  // (system-scoped) secret is missing — previously this was debug-only, so a
  // mis-scoped token left the channel silently dead with no signal.
  channelLogger.info(
    {
      discovered: discovered.length,
      registered: enabled.map((d) => d.channel.type),
      skipped: skipped.map((d) => d.channel.type),
    },
    skipped.length
      ? 'Channels initialized — skipped channels are not configured (set their system-scoped secret on the Secrets page)'
      : 'Channels initialized (auto-discovered)',
  );

  // Connect all registered channels
  await umi.connectAll();

  // Subscribe to permission requests and forward them to the originating channel
  getPermissionManager().onRequest(forwardPermissionRequestToChannel);
  getPermissionManager().onResolved(forgetResolvedChannelPermission);
  // Agent approvals are posted in their session's chat the same way, whether
  // or not a chat message started the run (./approval-prompts.ts).
  await startApprovalPrompts();
  // A task taken up in a group channel says in its thread when it closes.
  startTakenTaskNotices();

  // Bridge incoming channel messages → root agent → reply
  umi.on('message', async (message: UnifiedMessage) => {
    // Group channels: every reply goes into the thread the member wrote in.
    const groupChannelId = typeof message.metadata?.groupChannelId === 'string' ? message.metadata.groupChannelId : undefined;
    const replyThread = groupChannelId ? message.threadId : undefined;
    let leaveChat: (() => void) | undefined;
    // Stops this message's event subscriptions, typing and stall timers. Run
    // in `finally` too: a throw after they start must not leave a session-wide
    // subscription posting progress for later runs, or typing every 4s.
    let endFeedback: (() => void) | undefined;
    try {
      recordChannelMessage(message.channelType, 'inbound');
      // A yes/no reply to a permission prompt or an approval posted in this chat
      if (await tryResolvePromptReply(message)) return;

      // Process file attachments → document OCR pipeline (fire-and-forget)
      const attachmentDocuments: Promise<string[]> = message.attachments?.length
        ? processChannelAttachments(message).catch((err) => {
          channelLogger.error({ err, channelType: message.channelType }, 'Attachment processing failed');
          return [];
        })
        : Promise.resolve([]);

      const { getAgentService } = await import('@/core/agent');
      const rootAgent = getAgentService();

      const channelSessionId = (message.metadata?.sessionId as string) || `${message.channelType}-${message.channelId}`;

      // Platform-native message ID for reply-to (e.g. Telegram message_id)
      const platformMessageId = message.metadata?.messageId != null
        ? String(message.metadata.messageId)
        : undefined;

      // Resolve the actual DB session ID so we can match root agent events
      // (resolveSession converts "telegram-12345" → UUID, and events use the UUID)
      const groupTarget = groupChannelId ? await resolveGroupTurnSession(message, groupChannelId) : undefined;
      const resolvedSessionId = groupTarget
        ? groupTarget.sessionId
        : await (await import('@/core/agent/session-resolver')).resolveSession(channelSessionId, message.userId, message.channelType);
      // The member is in this chat now: approvals the turn raises are posted here.
      leaveChat = attendChat(resolvedSessionId);

      // "Take this on": the task goes on the member's board, linked to this
      // thread session, before the turn below works it (./take-work.ts).
      const takeRequest = groupTarget ? takeRequestOf(message.metadata?.take) : undefined;
      let taken: TakenWork | null = null;
      if (groupTarget && takeRequest) {
        taken = await startTakenWork({ message, sessionId: resolvedSessionId, group: groupTarget.group, request: takeRequest });
        if (!taken) return; // already on their board; told privately
      }

      // Subscribe to root agent events for progress feedback via emoji reactions
      const isExternalChannel = message.channelType !== 'webchat';
      let unsubscribe: (() => void) | null = null;
      let unsubAgentEvents: (() => void) | null = null;
      let typingInterval: ReturnType<typeof setInterval> | null = null;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let _lastEventTime = Date.now();
      let isTerminal = false;

      const react = (emoji: string) => {
        if (isTerminal || !platformMessageId) return; // Don't overwrite terminal states; Teams messages carry no id
        umi.setReaction(message.channelType, message.channelId, platformMessageId, emoji).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
      };

      const stopTypingAndStall = () => {
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      };
      endFeedback = () => {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (unsubAgentEvents) { unsubAgentEvents(); unsubAgentEvents = null; }
        stopTypingAndStall();
      };

      const resetStallTimer = () => {
        _lastEventTime = Date.now();
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

      if (isExternalChannel) {
        // Acknowledge receipt with 👀
        react('👀');

        // Repeating typing indicator — Telegram expires after 5s, so resend every 4s
        umi.sendTyping(message.channelType, message.channelId).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
        typingInterval = setInterval(() => {
          if (!isTerminal) {
            umi.sendTyping(message.channelType, message.channelId).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
          }
        }, 4_000);

        // Start stall detection
        resetStallTimer();

        // Role-specific emoji mapping
        const roleEmojis: Record<string, string> = {
          coding: '💻', research: '🔍', writing: '✍️', automation: '⏰',
          review: '🔍', security: '🔒', devops: '🐳', design: '🎨',
          data: '📊', qa: '🧪', rootAgent: '🤔',
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
            if (eventSessionId(event) !== resolvedSessionId) return;

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

        unsubscribe = rootAgent.onEvent((event) => {
          if (event.sessionId !== resolvedSessionId) return;
          resetStallTimer();

          switch (event.type) {
            case 'worker_spawned': {
              const d = event.data as { role?: string; model?: string; workerId?: string; root?: boolean };
              // The turn's root agent gets a 🤔 ack, not a "started X agent"
              // line — it is Octipus itself, not a specialist it dispatched.
              const role = d.root ? null : d.role;
              activeWorkers++;

              if (role) {
                react(roleEmojis[role] || '🧠');
                // Direct-response fast path (small talk) never spawns a real worker —
                // suppress the "started ... agent" text to avoid phantom announcements.
                const isDirect = d.model === 'direct';
                const key = `spawned-${role}`;
                if (!isDirect && !sentStatuses.has(key)) {
                  sentStatuses.add(key);
                  const model = d.model ? ` (${d.model})` : '';
                  umi.send(message.channelType, message.channelId, {
                    content: `Working on it \u2014 started *${role}* agent${model}.`,
                    replyTo: platformMessageId,
                    threadId: replyThread,
                  }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
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
            // 'team_started' / 'team_completed' events were emitted by the
            // deprecated spawn_team meta-tool; those have been removed in
            // favor of spawn_child + parallelGroup. No handler needed.
            case 'approval_required': {
              // The prompt itself is posted by ./approval-prompts.ts, keyed by
              // the session, so background runs and Teams get it too.
              react('⏳');
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
                  threadId: replyThread,
                }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
              }
              break;
            }
          }
        });
      }

      // Handle file attachments
      let messageContent = message.content;
      let voiceIn = false; // true when this turn came in as a voice note (drives voice-out)
      if (message.attachments?.length) {
        // Voice notes: transcribe inline so the utterance reaches the root agent
        // as text (all channels build audio attachments identically). Audio is not
        // in the document pipeline's PROCESSABLE_MIMES, so it dead-ended here before.
        const audioAttachments = message.attachments.filter(isAudioAttachment);
        if (audioAttachments.length) {
          voiceIn = true;
          const transcript = await transcribeChannelAudio(audioAttachments, message);
          if (!transcript) {
            await umi.send(message.channelType, message.channelId, {
              content: "Sorry, I couldn't transcribe that voice message. Please try again or type it out.",
              replyTo: platformMessageId,
              threadId: replyThread,
            });
            if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();
            return;
          }
          // A transcript becomes the caption — so a mixed voice+image message
          // now has a caption and takes the vision-analysis path below.
          messageContent = messageContent?.trim() ? `${messageContent}\n\n${transcript}` : transcript;
        }

        // Non-audio attachments keep the existing image/document handling.
        const fileAttachments = message.attachments.filter(a => !isAudioAttachment(a));
        if (fileAttachments.length) {
          const hasImages = fileAttachments.some(a => VISION_MIME_TYPES.has(a.mimeType));
          const hasNonImages = fileAttachments.some(a => !VISION_MIME_TYPES.has(a.mimeType));
          const hasCaption = messageContent && messageContent.trim().length > 0;

          // All attachments are routed through the document pipeline (fire-and-forget above).
          // For the root agent, decide: should we analyze inline or just acknowledge?

          if (!hasCaption) {
            // No caption — pure document upload. Acknowledge and skip root agent.
            const attachmentNames = fileAttachments.map(a => a.filename || 'file').join(', ');
            await umi.send(message.channelType, message.channelId, {
              content: `Received ${attachmentNames}. Processing through the document pipeline — I'll send you the summary when it's done.`,
              replyTo: platformMessageId,
              threadId: replyThread,
            });
            // Subscribe to document queue completions to send summary back
            subscribeToDocumentResults(message, umi, attachmentDocuments, platformMessageId, replyThread);
            if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();
            return;
          }

          if (hasImages && !hasNonImages) {
            // Only images with a caption — analyze with vision model for inline response
            const imageAnalysis = await analyzeImageAttachments(fileAttachments, message.channelType);
            if (imageAnalysis) {
              const prefix = `[The user sent image attachment(s). Vision model analysis:\n${imageAnalysis}]\n\n`;
              messageContent = prefix + messageContent;
            }
          } else {
            // Files (possibly mixed with images) + caption — acknowledge, send summaries when done
            const attachmentNames = fileAttachments.map(a => a.filename || 'file').join(', ');
            await umi.send(message.channelType, message.channelId, {
              content: `Received ${attachmentNames}. Processing — I'll send you the results when done.`,
              replyTo: platformMessageId,
              threadId: replyThread,
            });
            subscribeToDocumentResults(message, umi, attachmentDocuments, platformMessageId, replyThread);
            if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();
            return;
          }
        }
      }

      // Group channels: the member's text goes in unchanged, so commands,
      // plan "go" and approval replies are still recognised; only the model
      // sees it framed with the shared-audience notice and the transcript.
      const groupTurn = groupChannelId
        ? {
          requester: message.userName ?? 'A channel member',
          context: typeof message.metadata?.groupContext === 'string' ? message.metadata.groupContext : '',
          ...(taken ? { take: taken } : {}),
        }
        : undefined;

      const result = await rootAgent.handleMessage(
        resolvedSessionId,
        message.userId,
        messageContent,
        message.channelType,
        [],
        undefined,
        undefined,
        groupTurn,
      );

      // Unsubscribe from events
      if (unsubscribe) unsubscribe(); if (unsubAgentEvents) unsubAgentEvents(); stopTypingAndStall();

      // Send final reply back through the same channel
      if (result.response) {
        // A refusal for the member's own limits is posted in a shared thread
        // without its figures (the channel's own budget is posted as it is).
        const refusal = groupChannelId && result.metadata?.limit
          ? sharedRefusalText(result.metadata.limit, message.userName ?? 'this member')
          : null;
        const content = refusal ?? (isExternalChannel
          ? summarizeForChannel(result.response)
          : result.response);

        // Voice-in on Telegram → speak the reply back (Telegram sends the audio
        // clip before the text). Best-effort; undefined leaves a text-only reply.
        const attachments = voiceIn && message.channelType === 'telegram'
          ? await synthesizeVoiceReply(content)
          : undefined;

        await umi.send(message.channelType, message.channelId, {
          content,
          replyTo: platformMessageId,
          threadId: replyThread,
          attachments,
        });
        recordChannelMessage(message.channelType, 'outbound');
      }
    } catch (error) {
      channelLogger.error({ error, channelType: message.channelType }, 'Failed to process channel message');
      // Try to send error feedback to the user (without reply-to to avoid cascading failures)
      try {
        await umi.send(message.channelType, message.channelId, {
          content: 'Sorry, I encountered an error processing your message. Please try again later.',
          threadId: replyThread,
        });
      } catch {
        // Ignore send failure — channel may be disconnected
      }
    } finally {
      endFeedback?.();
      leaveChat?.();
    }
  });
}
