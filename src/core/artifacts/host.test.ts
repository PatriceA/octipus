import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildArtifactAppUrl, pickShareableUrl } from './host';

describe('buildArtifactAppUrl', () => {
  const originalEnv = process.env.PUBLIC_URL;

  beforeEach(() => {
    delete process.env.PUBLIC_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalEnv;
  });

  test('returns a relative path when PUBLIC_URL is unset', () => {
    expect(buildArtifactAppUrl('abc-123')).toBe('/artifacts/abc-123');
  });

  test('prefixes with PUBLIC_URL when set', () => {
    process.env.PUBLIC_URL = 'https://octi.example.com';
    expect(buildArtifactAppUrl('abc-123')).toBe('https://octi.example.com/artifacts/abc-123');
  });

  test('strips trailing slash from PUBLIC_URL', () => {
    process.env.PUBLIC_URL = 'https://octi.example.com/';
    expect(buildArtifactAppUrl('abc-123')).toBe('https://octi.example.com/artifacts/abc-123');
  });

  test('encodes the id', () => {
    expect(buildArtifactAppUrl('a/b c')).toMatch(/\/artifacts\/a%2Fb%20c$/);
  });
});

describe('pickShareableUrl', () => {
  const args = { slug: 'qa-issues', id: 'aaa' };

  test('public → outerUrl', () => {
    expect(pickShareableUrl({ ...args, visibility: 'public' })).toContain('/a/qa-issues');
  });

  test('signed → outerUrl (recipient uses the token)', () => {
    expect(pickShareableUrl({ ...args, visibility: 'signed' })).toContain('/a/qa-issues');
  });

  test('workspace → appUrl', () => {
    expect(pickShareableUrl({ ...args, visibility: 'workspace' })).toContain('/artifacts/aaa');
  });

  test('private → appUrl', () => {
    expect(pickShareableUrl({ ...args, visibility: 'private' })).toContain('/artifacts/aaa');
  });
});
