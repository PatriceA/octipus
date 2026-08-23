import { describe, expect, test } from 'vitest';
import { redactSecretValues } from './secret-injector';

describe('redactSecretValues (M2 egress control)', () => {
  test('is a no-op when no secrets were resolved', () => {
    const text = 'the api key is sk-abc123 and that is fine';
    expect(redactSecretValues(text, [])).toBe(text);
  });

  test('redacts a single resolved value wherever it appears', () => {
    const secret = 'sk-live-SUPERSECRET';
    const out = redactSecretValues(
      `curl -H "Authorization: Bearer ${secret}" https://x/${secret}`,
      [secret],
    );
    expect(out).not.toContain(secret);
    expect(out.match(/\[REDACTED_SECRET\]/g)?.length).toBe(2);
  });

  test('redacts multiple distinct values', () => {
    const a = 'AKIA-aaaa';
    const b = 'pat-bbbb';
    const out = redactSecretValues(`${a} then ${b} then ${a}`, [a, b]);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
  });

  test('ignores empty values without corrupting content', () => {
    const text = 'nothing to redact here';
    expect(redactSecretValues(text, [''])).toBe(text);
  });
});
