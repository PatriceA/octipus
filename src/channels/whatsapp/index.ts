import { createHmac } from 'crypto';
import { BaseChannel } from '../interface';
import { getConfig } from '@/config';
import { userRepository } from '@/db/repositories/user-repository';
import { generateLinkCode } from '@/channels/linking';
import { channelLogger } from '@/utils/logger';
import type { ChannelType, ChannelResponse, Attachment } from '@/core/types';

/**
 * WhatsApp Cloud API channel via Meta Business Platform.
 *
 * Webhook-based: Meta sends POST requests to our endpoint when messages arrive.
 * We send replies via the WhatsApp Cloud API (graph.facebook.com).
 */
export class WhatsAppChannel extends BaseChannel {
  readonly type: ChannelType = 'whatsapp';
  readonly name = 'WhatsApp';

  private accessToken: string | null = null;
  private phoneNumberId: string | null = null;
  private verifyToken: string | null = null;
  private appSecret: string | null = null;

  async connect(): Promise<void> {
    const config = getConfig();

    if (!config.whatsapp?.accessToken || !config.whatsapp?.phoneNumberId) {
      channelLogger.warn('WhatsApp access token or phone number ID not configured');
      return;
    }

    this.accessToken = config.whatsapp.accessToken;
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.verifyToken = config.whatsapp.verifyToken || 'assistant-whatsapp-verify';
    this.appSecret = config.whatsapp.appSecret || null;

    this.setConnected(true);
    channelLogger.info({ phoneNumberId: this.phoneNumberId }, 'WhatsApp channel initialized');
  }

  async disconnect(): Promise<void> {
    this.accessToken = null;
    this.phoneNumberId = null;
    this.verifyToken = null;
    this.appSecret = null;
    this.setConnected(false);
  }

  /**
   * Verify webhook subscription (GET request from Meta).
   * Meta sends hub.mode, hub.verify_token, hub.challenge.
   */
  handleVerification(query: {
    'hub.mode'?: string;
    'hub.verify_token'?: string;
    'hub.challenge'?: string;
  }): { status: number; body: string } {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === this.verifyToken) {
      channelLogger.info('WhatsApp webhook verified');
      return { status: 200, body: challenge || '' };
    }

    channelLogger.warn({ mode, tokenMatch: token === this.verifyToken }, 'WhatsApp webhook verification failed');
    return { status: 403, body: 'Forbidden' };
  }

  /**
   * Verify the X-Hub-Signature-256 header from Meta.
   */
  verifySignature(rawBody: string, signatureHeader: string | null): boolean {
    if (!this.appSecret) {
      // No app secret configured — skip verification (not recommended for production)
      return true;
    }

    if (!signatureHeader) return false;

    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') return false;

    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    return expected === parts[1];
  }

  /**
   * Process incoming webhook payload from Meta.
   */
  async processWebhook(body: WhatsAppWebhookPayload): Promise<void> {
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        if (!value?.messages) continue;

        for (const msg of value.messages) {
          await this.handleIncomingMessage(msg, value.metadata, value.contacts);
        }

        // Process status updates (delivered, read, etc.) — just log for now
        if (value.statuses) {
          for (const status of value.statuses) {
            channelLogger.debug(
              { recipientId: status.recipient_id, status: status.status, messageId: status.id },
              'WhatsApp message status update'
            );
          }
        }
      }
    }
  }

  private async handleIncomingMessage(
    msg: WhatsAppMessage,
    metadata: WhatsAppMetadata,
    contacts?: WhatsAppContact[]
  ): Promise<void> {
    const waUserId = msg.from; // phone number
    const contactName = contacts?.find(c => c.wa_id === waUserId)?.profile?.name;

    // Extract text content
    let content = '';
    const attachments: Attachment[] = [];

    switch (msg.type) {
      case 'text':
        content = msg.text?.body || '';
        break;

      case 'image':
        content = msg.image?.caption || '';
        attachments.push({
          type: 'image',
          url: msg.image?.id ? await this.getMediaUrl(msg.image.id) : undefined,
          mimeType: msg.image?.mime_type || 'image/jpeg',
        });
        break;

      case 'document':
        content = msg.document?.caption || '';
        attachments.push({
          type: 'file',
          url: msg.document?.id ? await this.getMediaUrl(msg.document.id) : undefined,
          mimeType: msg.document?.mime_type || 'application/octet-stream',
          filename: msg.document?.filename,
        });
        break;

      case 'audio':
        attachments.push({
          type: 'audio',
          url: msg.audio?.id ? await this.getMediaUrl(msg.audio.id) : undefined,
          mimeType: msg.audio?.mime_type || 'audio/ogg',
        });
        break;

      case 'video':
        attachments.push({
          type: 'video',
          url: msg.video?.id ? await this.getMediaUrl(msg.video.id) : undefined,
          mimeType: msg.video?.mime_type || 'video/mp4',
        });
        break;

      case 'location':
        content = `Location: ${msg.location?.latitude}, ${msg.location?.longitude}`;
        if (msg.location?.name) content += ` (${msg.location.name})`;
        break;

      case 'reaction':
        // Ignore reactions for now
        return;

      default:
        content = `[Unsupported message type: ${msg.type}]`;
    }

    if (!content && attachments.length === 0) return;

    // Deduplicate: ignore messages older than 60 seconds (Meta retries on previous failures)
    const msgAge = Date.now() / 1000 - Number(msg.timestamp);
    if (msgAge > 60) {
      channelLogger.debug({ waUserId, msgAge: Math.round(msgAge) }, 'Ignoring old/retried WhatsApp message');
      return;
    }

    // Find user binding first — needed for /link dedup
    const user = await userRepository.findByChannelBinding('whatsapp', waUserId);

    // Handle /link command
    if (content.startsWith('/link')) {
      if (user) {
        await this.sendTextMessage(waUserId, 'Your account is already linked!');
        return;
      }
      const code = await generateLinkCode({
        channelType: 'whatsapp',
        channelUserId: waUserId,
        channelUserName: contactName,
      });
      await this.sendTextMessage(
        waUserId,
        `Your link code: *${code}*\n\nEnter this code in the web UI at Settings → Channels within 5 minutes.`
      );
      return;
    }

    if (!user) {
      channelLogger.info({ waUserId, contactName }, 'New WhatsApp user - needs linking');
      await this.sendTextMessage(
        waUserId,
        'Welcome! Please link your account:\n1. Send /link here to get a link code\n2. Enter the code in the web UI at Settings → Channels'
      );
      return;
    }

    // Handle commands
    if (content.startsWith('/')) {
      await this.handleCommand(waUserId, content, user.id);
      return;
    }

    // Create unified message
    const message = this.createUnifiedMessage(waUserId, user.id, content, {
      userName: contactName,
      replyTo: msg.context?.id,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        whatsappUserId: waUserId,
        messageId: msg.id,
        phoneNumberId: metadata?.phone_number_id,
      },
    });

    this.emitMessage(message);
  }

  private async handleCommand(waUserId: string, command: string, userId: string): Promise<void> {
    const cmd = command.split(' ')[0].toLowerCase();

    switch (cmd) {
      case '/start':
        await this.sendTextMessage(waUserId, 'Hello! I am your AI assistant. How can I help you today?');
        break;

      case '/help':
        await this.sendTextMessage(
          waUserId,
          'Available commands:\n/start - Start conversation\n/help - Show this help\n/link - Get a code to link your account\n/status - Check bot status\n/clear - Clear conversation history'
        );
        break;

      case '/status':
        await this.sendTextMessage(waUserId, 'Bot is online and ready to assist you.');
        break;

      case '/link':
        await this.sendTextMessage(waUserId, 'Your account is already linked!');
        break;

      case '/clear':
        await this.sendTextMessage(waUserId, 'Conversation history cleared.');
        break;

      default:
        await this.sendTextMessage(waUserId, `Unknown command: ${cmd}`);
    }
  }

  async send(channelId: string, response: ChannelResponse): Promise<string> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new Error('WhatsApp channel not connected');
    }

    // Send attachments first
    if (response.attachments?.length) {
      for (const attachment of response.attachments) {
        await this.sendMedia(channelId, attachment);
      }
    }

    // Send text — WhatsApp has a 4096 character limit per message
    if (response.content) {
      const chunks = this.splitMessage(response.content, 4096);
      let lastId = '';
      for (const chunk of chunks) {
        lastId = await this.sendTextMessage(channelId, chunk, response.replyTo);
      }
      return lastId;
    }

    return '';
  }

  private async sendTextMessage(to: string, text: string, replyTo?: string): Promise<string> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: true, body: text },
    };

    if (replyTo) {
      payload.context = { message_id: replyTo };
    }

    const result = await this.callApi('messages', payload);
    return result?.messages?.[0]?.id || '';
  }

  private async sendMedia(to: string, attachment: Attachment): Promise<string> {
    if (!attachment.url) return '';

    let type: string;
    const mediaObj: Record<string, string> = {};

    switch (attachment.type) {
      case 'image':
        type = 'image';
        mediaObj.link = attachment.url;
        if (attachment.filename) mediaObj.caption = attachment.filename;
        break;
      case 'video':
        type = 'video';
        mediaObj.link = attachment.url;
        break;
      case 'audio':
        type = 'audio';
        mediaObj.link = attachment.url;
        break;
      default:
        type = 'document';
        mediaObj.link = attachment.url;
        if (attachment.filename) mediaObj.filename = attachment.filename;
        break;
    }

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      [type]: mediaObj,
    };

    const result = await this.callApi('messages', payload);
    return result?.messages?.[0]?.id || '';
  }

  /**
   * Get a media download URL from WhatsApp.
   */
  private async getMediaUrl(mediaId: string): Promise<string | undefined> {
    try {
      const result = await this.callGraphApi(mediaId);
      return result?.url;
    } catch (error) {
      channelLogger.error({ error, mediaId }, 'Failed to get WhatsApp media URL');
      return undefined;
    }
  }

  private async callApi(endpoint: string, payload: Record<string, unknown>): Promise<any> {
    const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      channelLogger.error(
        { status: response.status, body: errorBody, endpoint },
        'WhatsApp API error'
      );
      throw new Error(`WhatsApp API error: ${response.status} ${errorBody}`);
    }

    return response.json();
  }

  private async callGraphApi(path: string): Promise<any> {
    const url = `https://graph.facebook.com/v21.0/${path}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`WhatsApp Graph API error: ${response.status}`);
    }

    return response.json();
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = -1;

      const paragraphEnd = remaining.lastIndexOf('\n\n', maxLen);
      if (paragraphEnd > maxLen * 0.3) {
        splitAt = paragraphEnd + 2;
      }

      if (splitAt === -1) {
        const lineEnd = remaining.lastIndexOf('\n', maxLen);
        if (lineEnd > maxLen * 0.3) {
          splitAt = lineEnd + 1;
        }
      }

      if (splitAt === -1) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }

    return chunks;
  }
}

export const whatsappChannel = new WhatsAppChannel();

// ── WhatsApp Cloud API type definitions ──

export interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value: {
        messaging_product: string;
        metadata: WhatsAppMetadata;
        contacts?: WhatsAppContact[];
        messages?: WhatsAppMessage[];
        statuses?: WhatsAppStatus[];
      };
    }>;
  }>;
}

interface WhatsAppMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

interface WhatsAppContact {
  wa_id: string;
  profile: { name: string };
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type: string };
  video?: { id: string; mime_type: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  context?: { id: string; from?: string };
}

interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}
