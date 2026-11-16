import { describe, expect, test } from 'vitest';
import {
  applySkillPatch, assertPatchable, MAX_PATCH_NEW_CHARS, MAX_PATCHED_SKILL_CHARS, SkillPatchError, skillContentHash, validateSkillPatch,
} from './patch';

const content = '1. Build the image.\n2. Push it.\n3. Restart the service.\n4. Push it.\n';
const code = (fn: () => unknown) => {
  try { fn(); } catch (err) { return err instanceof SkillPatchError ? err.code : String(err); }
  return 'no error';
};

describe('exactly-once passage matching', () => {
  test('one match replaces exactly that passage', () => {
    expect(applySkillPatch(content, '3. Restart the service.', '3. Restart the service and wait for /health.'))
      .toBe('1. Build the image.\n2. Push it.\n3. Restart the service and wait for /health.\n4. Push it.\n');
  });
  test('zero matches is refused', () => {
    expect(code(() => applySkillPatch(content, '5. Celebrate.', 'x'))).toBe('not_found');
  });
  test('two matches is refused, more context makes it unique', () => {
    expect(code(() => applySkillPatch(content, 'Push it.', 'Push it with --tag.'))).toBe('ambiguous');
    expect(applySkillPatch(content, '2. Push it.', '2. Push it with --tag.')).toContain('2. Push it with --tag.\n3.');
  });
  test('no normalisation: case and whitespace must match exactly', () => {
    expect(code(() => applySkillPatch(content, '3. restart the service.', 'x'))).toBe('not_found');
    expect(code(() => applySkillPatch(content, '3.  Restart the service.', 'x'))).toBe('not_found');
  });
  test('overlapping repeats count as two matches', () => {
    expect(code(() => applySkillPatch('aaa', 'aa', 'b'))).toBe('ambiguous');
  });
});

describe('patch validation', () => {
  test('newText with personal data or secrets is refused, not redacted', () => {
    expect(code(() => validateSkillPatch(content, '2. Push it.', '2. Push it, then mail ops@example.com.'))).toBe('pii');
    expect(code(() => validateSkillPatch(content, '2. Push it.', `2. Push it with token: ${'a1'.repeat(15)}`))).toBe('pii');
  });
  test('size bounds and no-op patches', () => {
    expect(code(() => validateSkillPatch(content, '2. Push it.', 'x'.repeat(MAX_PATCH_NEW_CHARS + 1)))).toBe('size');
    expect(code(() => validateSkillPatch('step '.repeat(MAX_PATCHED_SKILL_CHARS / 5 - 1) + 'end', 'end', 'y'.repeat(100)))).toBe('size');
    expect(code(() => validateSkillPatch(content, '2. Push it.', '2. Push it.'))).toBe('no_change');
  });
  test('a valid patch returns the patched content; deletion is allowed', () => {
    expect(validateSkillPatch(content, '4. Push it.\n', '')).toBe('1. Build the image.\n2. Push it.\n3. Restart the service.\n');
  });
  test('content hash is exact', () => {
    expect(skillContentHash('a')).not.toBe(skillContentHash('a '));
    expect(skillContentHash(null)).toBe(skillContentHash(''));
  });
});

describe('which skills take patches', () => {
  const learned = { id: 'skill-1', isSystem: false, userId: 'u1', archivedAt: null, ownerEditedAt: null };
  test('the owner\'s unedited learned skill is patchable', () => {
    expect(code(() => assertPatchable(learned, 'u1'))).toBe('no error');
  });
  test('an owner-edited skill is locked', () => {
    expect(code(() => assertPatchable({ ...learned, ownerEditedAt: new Date('2026-11-01') }, 'u1'))).toBe('locked');
  });
  test('system, mounted, foreign, archived and missing skills are refused', () => {
    expect(code(() => assertPatchable({ ...learned, isSystem: true, userId: null }, 'u1'))).toBe('not_patchable');
    expect(code(() => assertPatchable({ ...learned, id: 'external:user:deploy' }, 'u1'))).toBe('not_patchable');
    expect(code(() => assertPatchable(learned, 'u2'))).toBe('not_patchable');
    expect(code(() => assertPatchable({ ...learned, archivedAt: new Date() }, 'u1'))).toBe('not_patchable');
    expect(code(() => assertPatchable(undefined, 'u1'))).toBe('missing');
  });
});
