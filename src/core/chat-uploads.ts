import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceFS } from '@/security/workspace-fs';
import { SessionFileError } from './session-files';
import type { ChatAttachment } from '@/shared/chat-attachments';

export function decodeChatAttachment(attachment: ChatAttachment): File {
  const bytes = Buffer.from(attachment.data, 'base64');
  if (bytes.toString('base64') !== attachment.data) {
    throw new SessionFileError(400, 'invalid_upload', 'Attachment data is not valid base64.');
  }
  return new File([bytes], attachment.name, { type: attachment.mimeType });
}

export const MAX_CHAT_UPLOAD_BYTES = 10 * 1024 * 1024;
export async function storeChatUploads(fs: WorkspaceFS, files: File[]) {
  if (!files.length || files.length > 10) throw new SessionFileError(400, 'invalid_upload', 'Attach between 1 and 10 files.');
  for (const file of files) {
    if (!(file instanceof Blob) || !file.size || file.size > MAX_CHAT_UPLOAD_BYTES) {
      throw new SessionFileError(400, 'invalid_upload', 'Each attachment must contain data and be no larger than 10 MiB.');
    }
  }
  await fs.ensureRoot();
  const uploaded = [];
  for (const file of files) {
    const name = (file.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const path = `.octipus/attachments/${randomUUID()}/${name}`;
    const target = fs.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(fs.resolve(path), Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
    uploaded.push({ path, name, mimeType: file.type, size: file.size });
  }
  return uploaded;
}
