import { describe, test, expect } from 'bun:test';
import { validateLocalAuth } from './local-auth';

describe('Local Auth', () => {
  test('rejects non-localhost IPs', () => {
    const result = validateLocalAuth('any-token', '192.168.1.100');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('localhost');
  });

  test('rejects empty token', () => {
    const result = validateLocalAuth('', '127.0.0.1');
    expect(result.valid).toBe(false);
  });

  test('accepts 127.0.0.1 as localhost', () => {
    // Will fail if no token file exists, but should not reject on IP
    const result = validateLocalAuth('test-token', '127.0.0.1');
    // Either valid (if token matches) or invalid (wrong token), but NOT "not allowed from localhost"
    if (!result.valid) {
      expect(result.reason).not.toContain('localhost');
    }
  });

  test('accepts ::1 as localhost', () => {
    const result = validateLocalAuth('test-token', '::1');
    if (!result.valid) {
      expect(result.reason).not.toContain('localhost');
    }
  });

  test('accepts ::ffff:127.0.0.1 as localhost', () => {
    const result = validateLocalAuth('test-token', '::ffff:127.0.0.1');
    if (!result.valid) {
      expect(result.reason).not.toContain('localhost');
    }
  });

  test('rejects external IPv4', () => {
    const result = validateLocalAuth('token', '10.0.0.1');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('localhost');
  });

  test('rejects external IPv6', () => {
    const result = validateLocalAuth('token', '2001:db8::1');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('localhost');
  });
});
