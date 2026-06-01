import { describe, expect, test } from 'bun:test';
import { assertPublicAddress, fetchGuarded, safeRegExp, sanitizeToolOutput, validateExternalUrl } from './sanitize';

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

  test('rejects decimal IP literal for 127.0.0.1 (2130706433)', async () => {
    const r = await validateExternalUrl('http://2130706433/');
    expect(r.valid).toBe(false);
  });

  test('rejects hex IP literal 0x7f000001', async () => {
    const r = await validateExternalUrl('http://0x7f000001/');
    expect(r.valid).toBe(false);
  });

  test('rejects octal-encoded octet 0177.0.0.1', async () => {
    const r = await validateExternalUrl('http://0177.0.0.1/');
    expect(r.valid).toBe(false);
  });

  test('rejects CGNAT range 100.64.0.1', async () => {
    const r = await validateExternalUrl('http://100.64.0.1/');
    expect(r.valid).toBe(false);
  });

  test('rejects IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', async () => {
    const r = await validateExternalUrl('http://[::ffff:127.0.0.1]/');
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

describe('assertPublicAddress (H3 post-connect rebinding check)', () => {
  test('accepts a public IP', () => {
    expect(assertPublicAddress('8.8.8.8').ok).toBe(true);
  });
  test('accepts null/undefined (nothing to check)', () => {
    expect(assertPublicAddress(null).ok).toBe(true);
    expect(assertPublicAddress(undefined).ok).toBe(true);
  });
  test('rejects loopback', () => {
    const r = assertPublicAddress('127.0.0.1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/private|reserved/i);
  });
  test('rejects RFC1918 + link-local + CGNAT', () => {
    expect(assertPublicAddress('10.1.2.3').ok).toBe(false);
    expect(assertPublicAddress('169.254.169.254').ok).toBe(false);
    expect(assertPublicAddress('100.64.0.1').ok).toBe(false);
  });
});

describe('validateExternalUrl returns vetted addresses (H3)', () => {
  test('public DNS host resolves to addresses for pinning', async () => {
    const r = await validateExternalUrl('https://one.one.one.one/');
    expect(r.valid).toBe(true);
    expect(Array.isArray(r.addresses)).toBe(true);
    expect((r.addresses ?? []).length).toBeGreaterThan(0);
  });
});

describe('fetchGuarded (H3)', () => {
  test('throws on a blocked (private) URL instead of connecting', async () => {
    await expect(fetchGuarded('http://127.0.0.1/')).rejects.toThrow(/SSRF guard|private|reserved/i);
  });
  test('throws on a disallowed scheme', async () => {
    await expect(fetchGuarded('file:///etc/passwd')).rejects.toThrow(/SSRF guard|scheme/i);
  });
});
