import { afterEach, expect, test, vi } from 'vitest';

const config = vi.hoisted(() => ({ trustedProxies: [] as string[] }));
vi.mock('@/config', () => ({ getConfig: () => ({ security: config }) }));
import { clientIp, parseTrustedProxies, recordedClientIp } from './client-ip';

const req = (headers: Record<string, string> = {}) => new Request('http://localhost/', { headers });
afterEach(() => { config.trustedProxies = []; });

test('without trusted proxies the socket address wins over every header', () => {
  expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }), '127.0.0.1')).toBe('127.0.0.1');
  expect(clientIp(req(), '::ffff:10.0.0.9')).toBe('10.0.0.9');
});

test('a trusted proxy is read right to left, skipping trusted hops and ignoring client-written ones', () => {
  config.trustedProxies = ['10.0.0.0/8', '::1'];
  expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.1.1.1' }), '10.0.0.2')).toBe('198.51.100.7');
  expect(clientIp(req({ 'x-real-ip': '198.51.100.8' }), '::1')).toBe('198.51.100.8');
  expect(clientIp(req(), '::ffff:10.0.0.2')).toBe('10.0.0.2');
  // A malformed hop from our own proxy falls back to the proxy, not the value.
  expect(clientIp(req({ 'x-forwarded-for': 'garbage' }), '10.0.0.2')).toBe('10.0.0.2');
});

test('no socket is "unknown", which a stored record leaves empty', () => {
  expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), undefined)).toBe('unknown');
  expect(recordedClientIp(req(), undefined)).toBeUndefined();
});

test('a malformed trustedProxies entry fails loudly', () => {
  expect(() => parseTrustedProxies(['10.0.0.0/33'])).toThrow(/invalid prefix/);
  expect(() => parseTrustedProxies(['proxy.local'])).toThrow(/not an IP address/);
  expect(() => parseTrustedProxies(['fd00::/8', '192.168.1.1'])).not.toThrow();
});
