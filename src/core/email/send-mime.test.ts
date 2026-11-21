import { describe, expect, test } from 'vitest';
import { buildSendRaw, EmailInputError, headerText, parseRecipientList, parseRecipients, replySubject } from './send-mime';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

describe('parseRecipientList', () => {
  test('plain, named and semicolon-separated addresses; duplicates once', () => {
    expect(parseRecipientList('a@x.de, Jane Doe <j@y.de>; "Doe, John" <john@z.org>, A@X.de', 'To')).toEqual(['a@x.de', 'j@y.de', 'john@z.org']);
    expect(parseRecipientList('', 'To')).toEqual([]);
    expect(parseRecipientList(undefined, 'Cc')).toEqual([]);
  });

  test.each([
    'not-an-address',
    'a@b',
    'victim@x.com\r\nBcc: attacker@evil.com',
    'victim@x.com\nBcc: attacker@evil.com',
    'a b@x.com',
    'a@x.com Bcc: e@evil.com',
    'Name <a@x.com> <b@y.com>',
    '<a@x.com',
    'a@x.com>',
    'a@x..',
  ])('rejects %j', (value) => {
    expect(() => parseRecipientList(value, 'To')).toThrow(EmailInputError);
  });
});

describe('parseRecipients', () => {
  test('needs a To and caps the total at 50', () => {
    expect(() => parseRecipients({ to: ' , ' })).toThrow('at least one recipient');
    const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.com`).join(',');
    expect(() => parseRecipients({ to: many, cc: many.replace(/u/g, 'c') })).toThrow('At most 50');
    expect(parseRecipients({ to: 'a@x.com', cc: 'b@x.com', bcc: 'c@x.com' })).toEqual({ to: ['a@x.com'], cc: ['b@x.com'], bcc: ['c@x.com'] });
  });
});

describe('buildSendRaw', () => {
  test('To, Cc, Bcc, subject and body', () => {
    const mime = decode(buildSendRaw({ to: ['a@x.com', 'b@x.com'], cc: ['c@x.com'], bcc: ['d@x.com'], subject: 'Plan', body: 'Line one\nLine two' }));
    const [head, body] = mime.split('\r\n\r\n');
    expect(head.split('\r\n')).toEqual([
      'To: a@x.com, b@x.com', 'Cc: c@x.com', 'Bcc: d@x.com', 'Subject: Plan',
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit',
    ]);
    expect(body).toBe('Line one\nLine two');
  });

  test('no Cc or Bcc line without such recipients', () => {
    const mime = decode(buildSendRaw({ to: ['a@x.com'], cc: [], bcc: [], subject: 'Hi', body: 'x' }));
    expect(mime).not.toMatch(/^(Cc|Bcc):/m);
  });

  test('a subject cannot add a header, and a non-ASCII one is encoded', () => {
    const head = decode(buildSendRaw({ to: ['a@x.com'], cc: [], bcc: [], subject: 'Hi\r\nBcc: attacker@evil.com', body: 'x' })).split('\r\n\r\n')[0];
    expect(head.split('\r\n').some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(head).toContain('Subject: Hi Bcc: attacker@evil.com');
    const encoded = headerText('Grüße aus München — Termin');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(Buffer.from(encoded.replace(/=\?UTF-8\?B\?|\?=|\r\n /g, ''), 'base64').toString('utf8')).toBe('Grüße aus München — Termin');
    for (const word of headerText('ü'.repeat(200)).split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
  });

  test('threading headers carry message ids only', () => {
    const head = decode(buildSendRaw({ to: ['a@x.com'], cc: [], bcc: [], subject: 'Re: Plan', body: 'x', inReplyTo: '<orig@x.com>\r\nBcc: e@evil.com', references: '<first@x.com> junk <second@x.com>' })).split('\r\n\r\n')[0];
    expect(head).toContain('In-Reply-To: <orig@x.com>\r\n');
    expect(head).toContain('References: <first@x.com> <second@x.com> <orig@x.com>\r\n');
    expect(head).not.toMatch(/evil/);
  });

  test('replySubject does not stack Re:', () => {
    expect(replySubject('Plan')).toBe('Re: Plan');
    expect(replySubject('RE: Plan')).toBe('RE: Plan');
    expect(replySubject('')).toBe('Re: (no subject)');
  });
});
