import { describe, expect, test } from 'vitest';
import { buildGmailRaw } from './service';

/** Decode a base64url MIME string back to text. */
function decode(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

describe('buildGmailRaw — header injection', () => {
  test('strips CRLF from recipient and subject (no Bcc injection)', () => {
    const mime = decode(buildGmailRaw('victim@x.com\r\nBcc: attacker@evil.com', 'Hi\r\nX-Spoof: yes', 'hello body'));
    const headerLines = mime.split('\r\n\r\n')[0].split('\r\n');
    // The injected text must NOT appear as its own header line — only inert
    // inside the collapsed To/Subject values.
    expect(headerLines.some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(headerLines.some((l) => /^x-spoof:/i.test(l))).toBe(false);
    expect(mime).toContain('To: victim@x.com Bcc: attacker@evil.com');
    expect(mime).toContain('Subject: Hi X-Spoof: yes');
    expect(mime).toContain('hello body');
  });

  test('clean input is unchanged', () => {
    const mime = decode(buildGmailRaw('bob@x.com', 'Meeting', 'See you at 3.'));
    expect(mime).toContain('To: bob@x.com');
    expect(mime).toContain('Subject: Meeting');
  });
});
