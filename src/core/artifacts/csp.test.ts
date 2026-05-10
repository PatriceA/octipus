import { describe, expect, test } from 'bun:test';
import { buildEmbedCsp } from './csp';

describe('buildEmbedCsp', () => {
  test('emits locked-down policy with sha256 script hashes', () => {
    const csp = buildEmbedCsp({
      scriptSha256s: ['a'.repeat(64)],
      gatewayWss: 'wss://gw.example.com',
    });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('wss://gw.example.com');
    expect(csp).toContain("'sha256-");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'none'");
  });

  test('extra frame-ancestors entries are appended', () => {
    const csp = buildEmbedCsp({
      scriptSha256s: [],
      frameAncestors: ['https://a.example', 'https://b.example'],
    });
    expect(csp).toMatch(/frame-ancestors 'self' https:\/\/a\.example https:\/\/b\.example/);
  });

  test('rejects malformed sha256 hex', () => {
    expect(() => buildEmbedCsp({ scriptSha256s: ['nothex'] })).toThrow();
  });
});
