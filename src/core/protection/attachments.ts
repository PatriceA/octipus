import { isModuleOn } from '@/core/modules/registry';
import type { AttachedFileRef } from '@/core/session-files';
import { isProtectionLevel } from '@/shared/protection';
import { ProtectionRoutingError } from './routing';
import { highestLevel, raiseSessionLevel } from './session-level';

/** Validate the user's choice before reading files or raising the session level. */
export function prepareAttachmentProtection(sessionId: string, files: AttachedFileRef[]): void {
  if (!files.length) return;
  const unclassified = files.some(file => !isProtectionLevel(file.protectionLevel));
  if (unclassified && isModuleOn('protection')) {
    throw new ProtectionRoutingError(4,
      'These attachments have not been classified. Choose their sensitivity in the chat composer before sending: Public, Internal, Confidential, or Strictly confidential. Their content has not been read for this request, and the attachments have not raised this conversation’s protection level.');
  }
  // With protection disabled, retain the conservative level for content that
  // will actually be read, so enabling protection later still covers it.
  raiseSessionLevel(sessionId, highestLevel(files.map(file => file.protectionLevel)));
}
