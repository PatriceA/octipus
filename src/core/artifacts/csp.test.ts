import { describe, expect, test } from 'vitest';
import { buildEmbedCsp, embedCspHeader } from './csp';

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

  test('the header copy sandboxes the page wherever it is opened; the meta copy does not carry it', () => {
    const csp = buildEmbedCsp({ scriptSha256s: [] });
    expect(csp).not.toContain('sandbox');
    expect(embedCspHeader(csp)).toMatch(/; sandbox allow-scripts$/);
  });

  test('a closed page reaches nothing: no fetch or socket, images only from data: and blob:', () => {
    const csp = buildEmbedCsp({ scriptSha256s: [], gatewayWss: 'wss://gw.example.com', network: 'none' });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('wss://gw.example.com');
    expect(csp).toContain('img-src data: blob:');
    expect(csp).not.toMatch(/img-src[^;]*https:/);
  });
});
