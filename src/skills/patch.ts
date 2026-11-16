/**
 * Patch proposals for learned skills: replace exactly one passage.
 *
 * Inspired by the learned skills of n8n's "nod": a patch names a passage of
 * the skill's current content and its replacement, and is refused unless that
 * passage occurs exactly once — compared byte for byte, with no whitespace or
 * case normalisation, so a patch can never land somewhere the reviewer did not
 * read. Unlike nod, nothing is applied automatically: a valid patch is filed as
 * a pending proposal and only an owner's approval writes it, after checking the
 * skill has not changed since (`baseContentHash`).
 *
 * Only learned skills take patches: the owner's own DB skills that the owner
 * has not written (`ownerEditedAt` NULL). System skills and mounted
 * filesystem (SKILL.md) skills are out of scope.
 */
import { createHash } from 'node:crypto';
import { filterPII } from '@/core/agent/pii-filter';
import type { SkillView } from '@/db/schema/skills';
import { isExternalSkillId } from './external-loader';

export const MAX_PATCH_OLD_CHARS = 2000;
export const MAX_PATCH_NEW_CHARS = 2500;
/** Repeated patches cannot grow a learned skill past this. */
export const MAX_PATCHED_SKILL_CHARS = 8000;

/** sha256 of the content exactly as stored ('' for none). */
export function skillContentHash(content: string | null | undefined): string {
  return createHash('sha256').update(content ?? '').digest('hex');
}

/** Why a patch cannot be filed or applied. Each carries a message for the receipt or the API. */
export class SkillPatchError extends Error {
  constructor(
    readonly code: 'not_found' | 'ambiguous' | 'pii' | 'size' | 'no_change' | 'not_patchable' | 'locked' | 'missing',
    message: string,
  ) { super(message); }
}

/**
 * `content` with the single occurrence of `oldText` replaced by `newText`.
 * Throws when `oldText` occurs zero times or more than once.
 */
export function applySkillPatch(content: string, oldText: string, newText: string): string {
  if (!oldText) throw new SkillPatchError('not_found', 'oldText must not be empty');
  const at = content.indexOf(oldText);
  if (at < 0) throw new SkillPatchError('not_found', 'oldText does not occur in the skill\'s current content (exact match, no normalisation)');
  if (content.indexOf(oldText, at + 1) >= 0) {
    throw new SkillPatchError('ambiguous', 'oldText occurs more than once in the skill; include enough surrounding text to match exactly one passage');
  }
  return content.slice(0, at) + newText + content.slice(at + oldText.length);
}

/** Size, change and PII checks on the patch itself; returns the patched content. */
export function validateSkillPatch(content: string, oldText: string, newText: string): string {
  if (oldText.length > MAX_PATCH_OLD_CHARS) throw new SkillPatchError('size', `oldText is longer than ${MAX_PATCH_OLD_CHARS} characters`);
  if (newText.length > MAX_PATCH_NEW_CHARS) throw new SkillPatchError('size', `newText is longer than ${MAX_PATCH_NEW_CHARS} characters`);
  if (oldText === newText) throw new SkillPatchError('no_change', 'newText is the same as oldText');
  // The same deterministic filter new skills go through. A skill proposal is
  // redacted; a patch is refused instead, because a redaction placeholder in
  // the middle of a precise replacement would land in the skill as-is.
  const pii = filterPII(newText);
  if (pii.hasRedactions) {
    throw new SkillPatchError('pii', `newText contains personal data or secrets (${[...new Set(pii.redactions.map(r => r.type))].join(', ')})`);
  }
  const patched = applySkillPatch(content, oldText, newText);
  if (patched.length > MAX_PATCHED_SKILL_CHARS) throw new SkillPatchError('size', `The patched skill would exceed ${MAX_PATCHED_SKILL_CHARS} characters`);
  return patched;
}

/**
 * Throws unless `skill` is a learned skill of `userId` that may take a patch.
 * `undefined` = no such skill (or not visible to this check).
 */
export function assertPatchable(skill: Pick<SkillView, 'id' | 'isSystem' | 'userId' | 'archivedAt' | 'ownerEditedAt'> | undefined, userId: string): asserts skill {
  if (!skill) throw new SkillPatchError('missing', 'The skill no longer exists');
  if (isExternalSkillId(skill.id)) throw new SkillPatchError('not_patchable', 'Mounted filesystem (SKILL.md) skills are read-only in Octipus; patch the source file');
  if (skill.isSystem) throw new SkillPatchError('not_patchable', 'Built-in system skills are not learned skills and take no patch proposals');
  if (skill.userId !== userId) throw new SkillPatchError('not_patchable', 'Only the owner\'s own learned skills take patch proposals');
  if (skill.archivedAt) throw new SkillPatchError('not_patchable', 'The skill is archived');
  if (skill.ownerEditedAt) {
    throw new SkillPatchError('locked', `The owner edited this skill (${skill.ownerEditedAt.toISOString().slice(0, 10)}); it is locked against automatic changes`);
  }
}
