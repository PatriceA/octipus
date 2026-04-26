import { describe, expect, test } from 'bun:test';
import { safeRegExp, sanitizeToolOutput, validateExternalUrl } from './sanitize';

describe('validateExternalUrl', () => {
  test('rejects malformed URL', async () => {
    const r = await validateExternalUrl('not a url');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Invalid URL');
  });

  test('rejects non-http(s) scheme', async () => {
    const r = await validateExternalUrl('ftp://example.com');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Disallowed scheme');
  });

  test('rejects file:// scheme', async () => {
    const r = await validateExternalUrl('file:///etc/passwd');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Disallowed scheme');
  });

  test('rejects localhost', async () => {
    const r = await validateExternalUrl('http://localhost/foo');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Localhost');
  });

  test('rejects 0.0.0.0', async () => {
    const r = await validateExternalUrl('http://0.0.0.0/');
    expect(r.valid).toBe(false);
  });

  test('rejects [::1]', async () => {
    const r = await validateExternalUrl('http://[::1]/');
    expect(r.valid).toBe(false);
  });

  test('rejects IP-literal in private 10.x range (DNS fails, falls through to literal check)', async () => {
    const r = await validateExternalUrl('http://10.0.0.1/');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('private/reserved');
  });

  test('rejects IP-literal in 172.16.x range', async () => {
    const r = await validateExternalUrl('http://172.20.5.1/');
    expect(r.valid).toBe(false);
  });

  test('rejects IP-literal 192.168.x.x', async () => {
    const r = await validateExternalUrl('http://192.168.1.1/');
    expect(r.valid).toBe(false);
  });

  test('rejects IP-literal 127.x.x.x loopback', async () => {
    const r = await validateExternalUrl('http://127.0.0.1/');
    expect(r.valid).toBe(false);
  });

  test('rejects IP-literal 169.254.x link-local', async () => {
    const r = await validateExternalUrl('http://169.254.169.254/');
    expect(r.valid).toBe(false);
  });

  test('public IP literal (8.8.8.8) is allowed', async () => {
    const r = await validateExternalUrl('http://8.8.8.8/');
    expect(r.valid).toBe(true);
  });

  test('rejects IPv6 ULA fc00::1', async () => {
    const r = await validateExternalUrl('http://[fc00::1]/');
    expect(r.valid).toBe(false);
  });

  test('rejects IPv6 link-local fe80::1', async () => {
    const r = await validateExternalUrl('http://[fe80::1]/');
    expect(r.valid).toBe(false);
  });
});

describe('safeRegExp', () => {
  test('compiles valid pattern', () => {
    const re = safeRegExp('^foo\\d+$');
    expect(re).not.toBeNull();
    expect(re!.test('foo42')).toBe(true);
  });

  test('returns null for invalid pattern', () => {
    expect(safeRegExp('[unclosed')).toBeNull();
  });

  test('rejects pattern over 200 chars', () => {
    expect(safeRegExp('a'.repeat(201))).toBeNull();
  });

  test('rejects repeated .* (3+) — catastrophic backtracking risk', () => {
    expect(safeRegExp('.*.*.*foo')).toBeNull();
  });

  test('honors flags', () => {
    const re = safeRegExp('foo', 'i');
    expect(re!.test('FOO')).toBe(true);
  });
});

describe('sanitizeToolOutput', () => {
  test('passes through string under limit', () => {
    expect(sanitizeToolOutput('hello')).toBe('hello');
  });

  test('null → empty string', () => {
    expect(sanitizeToolOutput(null)).toBe('');
  });

  test('undefined → empty string', () => {
    expect(sanitizeToolOutput(undefined)).toBe('');
  });

  test('object → JSON', () => {
    expect(sanitizeToolOutput({ a: 1 })).toBe('{"a":1}');
  });

  test('truncates over maxLength', () => {
    const r = sanitizeToolOutput('x'.repeat(100), { maxLength: 10 });
    expect(r).toBe('xxxxxxxxxx [truncated]');
  });

  test('respects default 50k limit (no truncate at 49k)', () => {
    const big = 'x'.repeat(49_000);
    expect(sanitizeToolOutput(big)).toBe(big);
  });

  test('circular object falls back to String()', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const r = sanitizeToolOutput(obj);
    expect(r).toBe('[object Object]');
  });

  test('number is JSON-stringified', () => {
    expect(sanitizeToolOutput(42)).toBe('42');
  });
});
