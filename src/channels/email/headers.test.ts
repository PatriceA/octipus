import { describe, expect, test } from 'vitest';
import { rawMail, TRUSTED_ID } from './fixtures';
import { authenticationVerdict, headerLines, loopReason, MAX_AUTH_RESULTS_CHARS, MalformedHeaders, parseAuthenticationResults, plainFromAddress } from './headers';

const T = [TRUSTED_ID];
const verdictOf = (headers: string[], domain = 'victim.com', ids = T) =>
  authenticationVerdict(headerLines(Buffer.from(`${headers.join('\r\n')}\r\nFrom: boss@${domain}\r\n\r\nbody`)), domain, ids);
const ar = (value: string) => `Authentication-Results: ${value}`;

describe('authentication: DMARC pass for the From domain, under the trusted id, and nothing else', () => {
  test('passes', () => {
    expect(verdictOf([ar(`${TRUSTED_ID}; spf=pass smtp.mailfrom=victim.com; dkim=pass header.d=victim.com; dmarc=pass (p=reject dis=none) header.from=victim.com`)])).toMatchObject({ ok: true });
    expect(verdictOf([ar(`MX.Octipus.Test 1; dmarc=pass header.from=Victim.COM`)])).toMatchObject({ ok: true });
    expect(verdictOf([ar(`(our server) ${TRUSTED_ID}; dmarc=pass header.from=victim.com`)])).toMatchObject({ ok: true });
    expect(verdictOf([`${ar(`${TRUSTED_ID};`)}`, '\tdmarc=pass header.from=victim.com'])).toMatchObject({ ok: true });
  });

  test('IDN: the From domain and header.from compare in punycode', () => {
    const lines = headerLines(Buffer.from(`${ar(`${TRUSTED_ID}; dmarc=pass header.from=xn--bcher-kva.example`)}\r\n\r\nb`));
    expect(authenticationVerdict(lines, 'bücher.example', T)).toMatchObject({ ok: true });
    expect(authenticationVerdict(lines, 'bucher.example', T)).toMatchObject({ ok: false });
  });

  const rejected: Array<[string, string[]]> = [
    // Reviewer vectors: sender-chosen values must never read as results.
    ['SPF quoted local part injecting DKIM', [ar(`${TRUSTED_ID}; spf=pass smtp.mailfrom="a;dkim=pass()header.d=victim.com;"@attacker.com`)]],
    ['SPF quoted local part injecting DMARC', [ar(`${TRUSTED_ID}; spf=pass smtp.mailfrom="x;dmarc=pass()header.from=victim.com;"@attacker.com`)]],
    ['DKIM selector injecting DMARC', [ar(`${TRUSTED_ID}; dkim=pass header.d=attacker.com header.s="s;dmarc=pass()header.from=victim.com;"`)]],
    ['HELO injecting DKIM', [ar(`${TRUSTED_ID}; spf=none smtp.helo=x;dkim=pass()header.d=victim.com`)]],
    ['reason injecting DKIM', [ar(`${TRUSTED_ID}; dkim=fail reason="bad; dkim=pass header.d=victim.com" header.d=victim.com`)]],
    ['header.i naming the victim', [ar(`${TRUSTED_ID}; dkim=pass header.d=attacker.com header.i=@victim.com`)]],
    ['DKIM pass for the From domain without DMARC', [ar(`${TRUSTED_ID}; dkim=pass header.d=victim.com`)]],
    ['SPF pass for the From domain without DMARC', [ar(`${TRUSTED_ID}; spf=pass smtp.mailfrom=victim.com`)]],
    ['DKIM at a public suffix', [ar(`${TRUSTED_ID}; dkim=pass header.d=co.uk`)]],
    ['dmarc=none', [ar(`${TRUSTED_ID}; dmarc=none header.from=victim.com; dkim=pass header.d=victim.com`)]],
    ['dmarc=fail with a pass in a comment', [ar(`${TRUSTED_ID}; dmarc=fail (dmarc=pass header.from=victim.com) header.from=victim.com`)]],
    ['DMARC pass for another domain', [ar(`${TRUSTED_ID}; dmarc=pass header.from=attacker.com`)]],
    ['DMARC pass for a parent domain', [ar(`${TRUSTED_ID}; dmarc=pass header.from=com`)]],
    ['an id that only starts like the trusted one', [ar(`${TRUSTED_ID}.attacker.com; dmarc=pass header.from=victim.com`)]],
    ['a pass below the trusted header', [ar(`${TRUSTED_ID}; dmarc=fail header.from=victim.com`), ar(`${TRUSTED_ID}; dmarc=pass header.from=victim.com`)]],
    ['another id above, failing trusted header below', [ar(`other.test; dmarc=pass header.from=victim.com`), ar(`${TRUSTED_ID}; dmarc=fail header.from=victim.com`)]],
    ['an unbalanced comment', [ar(`${TRUSTED_ID}; dmarc=fail (x header.from=victim.com; dmarc=pass header.from=victim.com`)]],
    ['a comment hiding a pass', [ar(`${TRUSTED_ID}; dkim=pass (good; dmarc=pass) header.d=attacker.com`)]],
    ['an unterminated quote', [ar(`${TRUSTED_ID}; dmarc=pass header.from=victim.com reason="x`)]],
    ['a malformed property', [ar(`${TRUSTED_ID}; dmarc=pass header.from=victim.com junk`)]],
    ['no header', []],
  ];
  test.each(rejected)('rejects: %s', (_name, headers) => {
    expect(verdictOf(headers)).toMatchObject({ ok: false });
  });

  test('fails closed without trusted ids', () => {
    expect(verdictOf([ar(`${TRUSTED_ID}; dmarc=pass header.from=victim.com`)], 'victim.com', [])).toMatchObject({ ok: false });
  });

  test('parsing follows RFC 8601: quoted strings and comments outside them', () => {
    expect(parseAuthenticationResults(`${TRUSTED_ID}; spf=pass smtp.mailfrom="a;b"@x.test; dkim=pass (ok) header.d=x.test reason="a ; b"`)).toEqual({
      authservId: TRUSTED_ID,
      results: [
        { method: 'spf', result: 'pass', props: { 'smtp.mailfrom': '"a;b"@x.test' } },
        { method: 'dkim', result: 'pass', reason: '"a ; b"', props: { 'header.d': 'x.test' } },
      ],
    });
    expect(parseAuthenticationResults(`${TRUSTED_ID}; none`)).toEqual({ authservId: TRUSTED_ID, results: [] });
  });

  test('deeply nested comments cost linear time', () => {
    const deep = `${TRUSTED_ID}; ${'('.repeat(40_000)}${')'.repeat(40_000)} dmarc=pass header.from=victim.com`;
    const started = Date.now();
    expect(verdictOf([ar(deep)])).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('the server\'s header inflated past the size limit is rejected, never skipped for a forged pass below it', () => {
    const results = Array.from({ length: 1200 }, (_, i) => `dkim=neutral (bad) header.d=attacker.com header.s=${'s'.repeat(60)}${i}`).join('; ');
    const real = ar(`${TRUSTED_ID}; ${results}; dmarc=fail header.from=victim.com`);
    expect(real.length).toBeGreaterThan(MAX_AUTH_RESULTS_CHARS);
    expect(verdictOf([real, ar(`${TRUSTED_ID}; dmarc=pass header.from=victim.com`)])).toEqual({ ok: false, why: 'unreadable' });
  });

  test('a long but legitimate header (many DKIM results) still passes', () => {
    const results = Array.from({ length: 40 }, (_, i) => `dkim=pass header.d=victim.com header.s=${'s'.repeat(60)}${i}`).join('; ');
    expect(results.length).toBeGreaterThan(3000);
    expect(verdictOf([ar(`${TRUSTED_ID}; ${results}; dmarc=pass header.from=victim.com`)])).toMatchObject({ ok: true });
  });
});

describe('the From address', () => {
  const from = (header: string, parsed: string[]) => plainFromAddress(headerLines(Buffer.from(`${header}\r\n\r\nb`)), parsed);

  test('one plain address, as written', () => {
    expect(from('From: Ann <Ann@Example.com>', ['Ann@Example.com'])).toBe('ann@example.com');
  });

  test('an encoded word, two addresses or two From headers are refused', () => {
    expect(from('From: =?utf-8?q?victim=40victim.com?=', ['victim@victim.com'])).toBeNull();
    expect(from('From: a@x.test, b@y.test', ['a@x.test', 'b@y.test'])).toBeNull();
    expect(from('From: a@x.test\r\nFrom: b@y.test', ['a@x.test'])).toBeNull();
    expect(from('From: victim@[1.2.3.4]', ['victim@[1.2.3.4]'])).toBeNull();
  });

  test('a bare CR in the headers is malformed', () => {
    expect(() => headerLines(Buffer.from('From: attacker@evil.com\rFrom: victim@victim.com\r\n\r\nb'))).toThrow(MalformedHeaders);
  });
});

describe('loop guards', () => {
  const reason = (raw: Buffer, sender = 'ann@example.com') => loopReason(headerLines(raw), sender, 'octipus@company.test');

  test('an ordinary mail passes', () => {
    expect(reason(rawMail())).toBeNull();
    expect(reason(rawMail({ extra: ['Auto-Submitted: no'] }))).toBeNull();
  });

  test('auto replies, bulk, lists, bounces and our own address are never answered', () => {
    expect(reason(rawMail({ extra: ['Auto-Submitted: auto-replied'] }))).toBe('auto_submitted');
    expect(reason(rawMail({ extra: ['X-Autoreply: yes'] }))).toBe('auto_submitted');
    expect(reason(rawMail({ extra: ['Precedence: bulk'] }))).toBe('bulk');
    expect(reason(rawMail({ extra: ['List-Id: <team.example.com>'] }))).toBe('mailing_list');
    expect(reason(rawMail({ extra: ['Return-Path: <>'] }))).toBe('bounce');
    expect(reason(rawMail(), 'MAILER-DAEMON@example.com')).toBe('bounce');
    expect(reason(rawMail(), 'Octipus@Company.test')).toBe('own_address');
  });
});
