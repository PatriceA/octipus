import { describe, expect, test } from 'vitest';
import { isSafeReturnTo, loginPathReturningTo, RETURN_TO_MAX_LENGTH } from './return-to';

describe('isSafeReturnTo', () => {
  test.each([
    '/',
    '/chat',
    '/notes?id=1&tab=links',
    '/agents/view#timeline',
    '/a/b/c/',
    '/%2F%2Fencoded-stays-a-path',
  ])('accepts the same-origin path %s', (value) => {
    expect(isSafeReturnTo(value)).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['relative', 'chat'],
    ['absolute URL', 'https://evil.example/'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,hi'],
    ['protocol-relative', '//evil.example'],
    ['triple slash', '///evil.example'],
    ['backslash after slash', '/\\evil.example'],
    ['backslash anywhere', '/chat\\..\\evil'],
    ['leading backslash', '\\\\evil.example'],
    ['tab that a browser strips to //', '/\t/evil.example'],
    ['newline', '/\n/evil.example'],
    ['space', '/ /evil.example'],
    ['DEL', '/\u007f/evil'],
    ['C1 control', '/\u0085/evil'],
    ['too long', `/${'a'.repeat(RETURN_TO_MAX_LENGTH)}`],
  ])('refuses %s', (_label, value) => {
    expect(isSafeReturnTo(value)).toBe(false);
  });

  test.each([undefined, null, 42, {}, ['/chat']])('refuses the non-string %j', (value) => {
    expect(isSafeReturnTo(value)).toBe(false);
  });
});

describe('loginPathReturningTo', () => {
  test('carries the current page, encoded', () => {
    expect(loginPathReturningTo('/notes?id=1')).toBe('/login?returnTo=%2Fnotes%3Fid%3D1');
  });

  test.each(['/', '/login', '/login?returnTo=%2Fchat', '//evil.example'])(
    'is plain /login for %s',
    (current) => {
      expect(loginPathReturningTo(current)).toBe('/login');
    },
  );
});
