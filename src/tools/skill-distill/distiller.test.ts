import { describe, expect, test } from 'vitest';
import { cosine, interpretDistillOutput, normalizeSkillName, skillFingerprint } from './distiller';

describe('interpretDistillOutput', () => {
  const good = JSON.stringify({ name: 'deploy-runbook', description: 'How to deploy', content: '1. build\n2. ship' });

  test('parses a clean JSON object', () => {
    expect(interpretDistillOutput(good, 'stop')).toEqual({
      kind: 'skill',
      skill: { name: 'deploy-runbook', description: 'How to deploy', content: '1. build\n2. ship' },
    });
  });

  test('tolerates a ```json fence and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n' + good + '\n```\nHope that helps.';
    expect(interpretDistillOutput(raw, 'stop')).toMatchObject({ kind: 'skill', skill: { name: 'deploy-runbook' } });
  });

  test('trims fields', () => {
    const raw = JSON.stringify({ name: '  x-y ', description: ' d ', content: ' c ' });
    expect(interpretDistillOutput(raw)).toEqual({ kind: 'skill', skill: { name: 'x-y', description: 'd', content: 'c' } });
  });

  test('the blank sentinel is the only "nothing worth saving"', () => {
    expect(interpretDistillOutput(JSON.stringify({ name: '', description: '', content: '' }), 'stop')).toEqual({ kind: 'none' });
  });

  // Regression: a 1500-token cap cut the JSON mid-string and the tool told the
  // user there was "nothing worth distilling".
  test("finishReason 'length' ⇒ truncated, never none", () => {
    const cut = good.slice(0, 40);
    expect(interpretDistillOutput(cut, 'length')).toEqual({ kind: 'truncated' });
    expect(interpretDistillOutput(good, 'length')).toEqual({ kind: 'truncated' });
  });

  test('cut-off JSON without a length signal ⇒ malformed', () => {
    expect(interpretDistillOutput(good.slice(0, 40), 'stop')).toMatchObject({ kind: 'malformed' });
  });

  test('partially blank fields ⇒ malformed', () => {
    expect(interpretDistillOutput(JSON.stringify({ name: 'x', description: '', content: 'c' }))).toMatchObject({ kind: 'malformed' });
  });

  test('missing / non-string field ⇒ malformed', () => {
    expect(interpretDistillOutput(JSON.stringify({ name: 'x', description: 'd' }))).toMatchObject({ kind: 'malformed' });
    expect(interpretDistillOutput(JSON.stringify({ name: 1, description: 'd', content: 'c' }))).toMatchObject({ kind: 'malformed' });
  });

  test('unparseable output ⇒ malformed with a reason', () => {
    expect(interpretDistillOutput('not json at all')).toEqual({ kind: 'malformed', reason: 'no JSON object in the response' });
    expect(interpretDistillOutput('')).toMatchObject({ kind: 'malformed' });
    const bad = interpretDistillOutput('{"name": "ECHO_MARKER_7f3a",}');
    expect(bad).toEqual({ kind: 'malformed', reason: 'invalid JSON' });
    expect(JSON.stringify(bad)).not.toContain('ECHO_MARKER_7f3a');
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
