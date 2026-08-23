import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { _resetArtifactTokenKey, signArtifactToken, verifyArtifactToken } from './token';

beforeAll(() => {
  // Token signer falls back to JWT_SECRET HKDF when settings service isn't booted.
  process.env.JWT_SECRET = 'test-jwt-' + 'x'.repeat(24);
});
afterEach(() => _resetArtifactTokenKey());

describe('artifact token', () => {
  const base = {
    aid: 'art-1',
    wid: 'ws-1',
    scope: 'view' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };

  test('round-trip', () => {
    const tok = signArtifactToken(base);
    const v = verifyArtifactToken(tok, { aid: 'art-1' });
    expect(v?.aid).toBe('art-1');
    expect(v?.aud).toBe('artifact:art-1');
    expect(v?.scope).toBe('view');
  });

  test('rejects wrong audience', () => {
    const tok = signArtifactToken(base);
    expect(verifyArtifactToken(tok, { aid: 'other' })).toBeNull();
  });

  test('rejects expired', () => {
    const tok = signArtifactToken({ ...base, exp: Math.floor(Date.now() / 1000) - 5 });
    expect(verifyArtifactToken(tok, { aid: 'art-1' })).toBeNull();
  });

  test('rejects tampered payload', () => {
    const tok = signArtifactToken(base);
    const [h, p, s] = tok.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...base, aud: 'artifact:art-1', scope: 'view+refresh' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyArtifactToken(`${h}.${tampered}.${s}`, { aid: 'art-1' })).toBeNull();
  });

  test('rejects malformed', () => {
    expect(verifyArtifactToken('garbage', { aid: 'art-1' })).toBeNull();
    expect(verifyArtifactToken('a.b', { aid: 'art-1' })).toBeNull();
  });
});
