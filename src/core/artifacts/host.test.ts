import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildArtifactAppUrl, buildArtifactOuterUrl, pickShareableUrl } from './host';

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

describe('buildArtifactOuterUrl', () => {
  const originalEnv = process.env.PUBLIC_URL;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalEnv;
  });

  // The link gets pasted into Telegram/Slack; a bare `/__artifacts__/...`
  // is not a link there.
  test('path-prefix mode returns an absolute URL when PUBLIC_URL is set', () => {
    process.env.PUBLIC_URL = 'https://octi.example.com/';
    expect(buildArtifactOuterUrl('qa-issues')).toBe('https://octi.example.com/__artifacts__/a/qa-issues');
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
