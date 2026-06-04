import { describe, expect, test } from 'bun:test';
import { REDACTED, redactLogObject } from './log-redact';

describe('redactLogObject', () => {
  test('redacts credential-shaped keys at the top level', () => {
    const out = redactLogObject({
      username: 'alice',
      password: 'hunter2',
      apiKey: 'sk-live-123',
      api_key: 'sk-live-456',
      secret: 'shh',
      authorization: 'Bearer abc',
    });
    expect(out.username).toBe('alice');
    expect(out.password).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
  });

  test('redacts nested keys inside tool arguments', () => {
    const out = redactLogObject({
      tool: 'http',
      args: { url: 'https://x', headers: { authorization: 'Bearer t', accept: 'json' } },
    });
    const args = out.args as Record<string, any>;
    expect(args.url).toBe('https://x');
    expect(args.headers.authorization).toBe(REDACTED);
    expect(args.headers.accept).toBe('json');
  });

  test('redacts inside arrays', () => {
    const out = redactLogObject({
      items: [{ token: 'a', id: 1 }, { token: 'b', id: 2 }],
    });
    const items = out.items as Array<Record<string, any>>;
    expect(items[0].token).toBe(REDACTED);
    expect(items[0].id).toBe(1);
    expect(items[1].token).toBe(REDACTED);
  });

  test('keeps non-secret token-like keys (correlation/metrics fields)', () => {
    const out = redactLogObject({
      requestId: 'req-1',
      tokenCount: 42,
      totalTokens: 100,
      sessionId: 's-1',
    });
    expect(out.requestId).toBe('req-1');
    expect(out.tokenCount).toBe(42);
    expect(out.totalTokens).toBe(100);
    expect(out.sessionId).toBe('s-1');
  });

  test('redacts sessionToken but not sessionId', () => {
    const out = redactLogObject({ sessionId: 's-1', sessionToken: 'tok' });
    expect(out.sessionId).toBe('s-1');
    expect(out.sessionToken).toBe(REDACTED);
  });

  test('passes through Error instances untouched (pino serializes them)', () => {
    const err = new Error('boom');
    const out = redactLogObject({ err });
    expect(out.err).toBe(err);
    expect((out.err as Error).message).toBe('boom');
  });

  test('truncates oversized strings', () => {
    const big = 'x'.repeat(20_000);
    const out = redactLogObject({ blob: big });
    expect((out.blob as string).length).toBeLessThan(big.length);
    expect(out.blob as string).toContain('truncated');
  });

  test('handles circular references without throwing', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => redactLogObject(a)).not.toThrow();
    const out = redactLogObject(a);
    expect(out.self).toBe('[Circular]');
  });

  test('does not mutate the input object', () => {
    const input = { password: 'secret', nested: { token: 't' } };
    redactLogObject(input);
    expect(input.password).toBe('secret');
    expect(input.nested.token).toBe('t');
  });
});
