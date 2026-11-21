/**
 * Files waiting to go out with a mail from the Email page.
 *
 * A file is uploaded on its own as soon as it is picked (POST
 * /api/email/uploads) and held here, in memory, for the user who uploaded it,
 * until the send that names it, or for an hour. That keeps the send itself a
 * small JSON request behind the same `confirm: true` gate as before, lets the
 * page refuse a file that is too large the moment it is added, and lets a
 * forward name the original's attachments the same way (fetched from the
 * provider at send time, never round-tripped through the browser).
 *
 * In memory on purpose: nothing about a mail is written to disk before it is
 * sent. A restart drops what was waiting; the page then says the file is gone.
 */
import { randomUUID } from 'node:crypto';
import { EmailInputError, MAX_ATTACHMENT_BYTES, type OutgoingFile, safeContentType, safeFileName } from './send-mime';

/** How long an upload waits for its send. */
export const UPLOAD_TTL_MS = 60 * 60_000;
/** What one user may hold at once: one full mail and some room to change one's mind. */
export const USER_MAX_BYTES = 2 * MAX_ATTACHMENT_BYTES;
export const USER_MAX_FILES = 40;

interface Held extends OutgoingFile { at: number }
const held = new Map<string, Map<string, Held>>();

function mine(userId: string, now = Date.now()): Map<string, Held> {
  let files = held.get(userId);
  if (!files) { files = new Map(); held.set(userId, files); }
  for (const [id, file] of files) if (now - file.at > UPLOAD_TTL_MS) files.delete(id);
  return files;
}

export interface UploadView { id: string; name: string; size: number; contentType: string }

/** Hold one file for the user. Throws EmailInputError past the limits. */
export function holdUpload(userId: string, input: { name: string; contentType?: string; content: Uint8Array }, now = Date.now()): UploadView {
  if (input.content.byteLength === 0) throw new EmailInputError('The file is empty.');
  if (input.content.byteLength > MAX_ATTACHMENT_BYTES) throw new EmailInputError(`A file may be at most ${MAX_ATTACHMENT_BYTES / 1048576} MB.`);
  const files = mine(userId, now);
  if (files.size >= USER_MAX_FILES) throw new EmailInputError('Too many files are waiting to be sent. Send or remove some first.');
  const total = [...files.values()].reduce((sum, f) => sum + f.content.byteLength, 0);
  if (total + input.content.byteLength > USER_MAX_BYTES) throw new EmailInputError('Too much is waiting to be sent. Send or remove some files first.');
  const id = randomUUID();
  const file: Held = { name: safeFileName(input.name), contentType: safeContentType(input.contentType), content: input.content, at: now };
  files.set(id, file);
  return { id, name: file.name, size: file.content.byteLength, contentType: file.contentType };
}

/** The user's held files by id, in the order asked. Throws when one is gone (expired, or another user's). */
export function heldUploads(userId: string, ids: string[]): OutgoingFile[] {
  const files = mine(userId);
  return ids.map((id) => {
    const file = files.get(id);
    if (!file) throw new EmailInputError('An attachment is no longer waiting on the server. Remove it and add it again.');
    return { name: file.name, contentType: file.contentType, content: file.content };
  });
}

/** Let go of files: after their send, or when the writer removes them. */
export function dropUploads(userId: string, ids: string[]): void {
  const files = held.get(userId);
  if (!files) return;
  for (const id of ids) files.delete(id);
  if (files.size === 0) held.delete(userId);
}

/** For tests. */
export function clearUploads(): void {
  held.clear();
}

/** What a send names as an attachment: a held upload, or a file of a message in the mailbox (a forward). */
export type AttachmentRef = { upload: string } | { forward: { messageId: string; attachmentId: string } };

/**
 * The files a send names, in order: held uploads from memory, a forwarded
 * message's files fetched from the provider now. Limits are checked by the
 * send. Returns the upload ids to let go of once the mail is out.
 */
export async function resolveAttachments(
  userId: string,
  refs: AttachmentRef[],
  fetchForwarded: (messageId: string, attachmentId: string) => Promise<OutgoingFile>,
): Promise<{ files: OutgoingFile[]; uploads: string[] }> {
  const uploads = refs.flatMap((ref) => ('upload' in ref ? [ref.upload] : []));
  const fromMemory = heldUploads(userId, uploads);
  const files: OutgoingFile[] = [];
  let next = 0;
  for (const ref of refs) {
    if ('upload' in ref) files.push(fromMemory[next++]);
    else {
      const file = await fetchForwarded(ref.forward.messageId, ref.forward.attachmentId);
      files.push({ name: safeFileName(file.name), contentType: safeContentType(file.contentType), content: file.content });
    }
  }
  return { files, uploads };
}
