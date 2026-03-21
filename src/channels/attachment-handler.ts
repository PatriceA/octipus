/**
 * Channel attachment handler — downloads file attachments from channel messages
 * and enqueues them for document processing (OCR, categorization, indexing).
 */

import { resolve, join, extname } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getConfig } from '@/config';
import { documentRepository } from '@/db/repositories/document-repository';
import { getDocumentQueue } from '@/core/documents/queue';
import { channelLogger } from '@/utils/logger';
import type { Attachment, UnifiedMessage } from '@/core/types';

/** MIME types worth processing for document extraction */
const PROCESSABLE_MIMES = new Set([
  // Images (OCR)
  'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp', 'image/avif',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json', 'application/xml', 'text/xml',
  'text/html',
]);

/** File extensions to process if MIME type is generic */
const PROCESSABLE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.md',
  '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.log',
  '.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.webp', '.avif',
]);

function isProcessable(attachment: Attachment): boolean {
  if (PROCESSABLE_MIMES.has(attachment.mimeType)) return true;
  if (attachment.filename) {
    const ext = extname(attachment.filename).toLowerCase();
    if (PROCESSABLE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/**
 * Process attachments from a channel message:
 * download files, create DB records, enqueue for OCR/categorization.
 */
export async function processChannelAttachments(message: UnifiedMessage): Promise<void> {
  if (!message.attachments?.length) return;

  const processable = message.attachments.filter(isProcessable);
  if (processable.length === 0) return;

  const config = getConfig();
  const documentsPath = resolve(config.workspace.documentsPath || './workspace/documents');
  const uncategorizedDir = join(documentsPath, 'uncategorized');

  if (!existsSync(uncategorizedDir)) {
    await mkdir(uncategorizedDir, { recursive: true });
  }

  for (const attachment of processable) {
    try {
      const fileBuffer = await downloadAttachment(attachment, message);
      if (!fileBuffer || fileBuffer.length === 0) continue;

      const originalName = attachment.filename || `${message.channelType}-${Date.now()}${guessExtension(attachment.mimeType)}`;
      const ext = extname(originalName) || guessExtension(attachment.mimeType);
      const uniqueFilename = `${randomUUID()}${ext}`;
      const storagePath = join(uncategorizedDir, uniqueFilename);

      await Bun.write(storagePath, fileBuffer);

      const doc = await documentRepository.create({
        userId: message.userId,
        filename: uniqueFilename,
        originalName,
        mimeType: attachment.mimeType,
        size: fileBuffer.length,
        storagePath,
        status: 'queued',
      });

      getDocumentQueue().enqueue(doc.id, message.userId);

      channelLogger.info(
        { documentId: doc.id, filename: originalName, channel: message.channelType, size: fileBuffer.length },
        'Channel attachment enqueued for processing'
      );
    } catch (err) {
      channelLogger.error(
        { err, filename: attachment.filename, channel: message.channelType },
        'Failed to process channel attachment'
      );
    }
  }
}

async function downloadAttachment(attachment: Attachment, message: UnifiedMessage): Promise<Buffer | null> {
  // If the attachment already has data, use it
  if (attachment.data) {
    return Buffer.from(attachment.data);
  }

  if (!attachment.url) return null;

  try {
    const headers: Record<string, string> = {};

    // Slack files need bot token authorization
    if (message.channelType === 'slack') {
      const config = getConfig();
      if (config.slack?.botToken) {
        headers['Authorization'] = `Bearer ${config.slack.botToken}`;
      }
    }

    // WhatsApp media URLs need access token
    if (message.channelType === 'whatsapp') {
      const config = getConfig();
      if (config.whatsapp?.accessToken) {
        headers['Authorization'] = `Bearer ${config.whatsapp.accessToken}`;
      }
    }

    const response = await fetch(attachment.url, { headers });
    if (!response.ok) {
      channelLogger.warn(
        { url: attachment.url, status: response.status },
        'Failed to download attachment'
      );
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    channelLogger.error({ err, url: attachment.url }, 'Attachment download error');
    return null;
  }
}

function guessExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/tiff': '.tiff',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/markdown': '.md',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/xml': '.xml',
    'text/html': '.html',
  };
  return map[mimeType] || '';
}
