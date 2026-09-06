import { describe, expect, test } from 'vitest';
import { cosine, normalizeSkillName, parseDistilledSkill, skillFingerprint } from './distiller';

describe('parseDistilledSkill', () => {
  const good = JSON.stringify({ name: 'deploy-runbook', description: 'How to deploy', content: '1. build\n2. ship' });

  test('parses a clean JSON object', () => {
    expect(parseDistilledSkill(good)).toEqual({
      name: 'deploy-runbook',
      description: 'How to deploy',
      content: '1. build\n2. ship',
    });
  });

  test('tolerates a ```json fence and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n' + good + '\n```\nHope that helps.';
    expect(parseDistilledSkill(raw)?.name).toBe('deploy-runbook');
  });

  test('trims fields', () => {
    const raw = JSON.stringify({ name: '  x-y ', description: ' d ', content: ' c ' });
    expect(parseDistilledSkill(raw)).toEqual({ name: 'x-y', description: 'd', content: 'c' });
  });

  test('the blank sentinel (nothing worth saving) ⇒ null', () => {
    expect(parseDistilledSkill(JSON.stringify({ name: '', description: '', content: '' }))).toBeNull();
  });

  test('any blank required field ⇒ null', () => {
    expect(parseDistilledSkill(JSON.stringify({ name: 'x', description: '', content: 'c' }))).toBeNull();
  });

  test('missing / non-string field ⇒ null', () => {
    expect(parseDistilledSkill(JSON.stringify({ name: 'x', description: 'd' }))).toBeNull();
    expect(parseDistilledSkill(JSON.stringify({ name: 1, description: 'd', content: 'c' }))).toBeNull();
  });

  test('unparseable output ⇒ null', () => {
    expect(parseDistilledSkill('not json at all')).toBeNull();
    expect(parseDistilledSkill('')).toBeNull();
  });
});

describe('skillFingerprint', () => {
  test('is stable and case-insensitive on the name', () => {
    expect(skillFingerprint('u1', 'Deploy Runbook')).toBe(skillFingerprint('u1', 'deploy runbook'));
  });

  test('differs by user and by name', () => {
    expect(skillFingerprint('u1', 'a')).not.toBe(skillFingerprint('u2', 'a'));
    expect(skillFingerprint('u1', 'a')).not.toBe(skillFingerprint('u1', 'b'));
  });
});

describe('normalizeSkillName', () => {
  test('collapses case and punctuation — the four-duplicates bug', () => {
    expect(normalizeSkillName('Token Rotation Procedure')).toBe('token-rotation-procedure');
    expect(normalizeSkillName('  token_rotation/procedure! ')).toBe('token-rotation-procedure');
  });

  test('a name of pure punctuation does not collide with another one', () => {
    expect(normalizeSkillName('---')).toBe('');
    expect(skillFingerprint('u1', '---')).not.toBe(skillFingerprint('u1', '!!!'));
  });

  test('names that survive normalization stay distinct', () => {
    expect(normalizeSkillName('vault-token-rotation')).not.toBe(normalizeSkillName('secure-credential-rotation'));
  });
});

describe('cosine', () => {
  test('parallel = 1, orthogonal = 0', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('degenerate input scores 0 rather than NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1], [1, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});
