import { describe, expect, test } from 'vitest';
import { rawMail, TRUSTED_ID } from './fixtures';
import { aligned, authenticationVerdict, headerLines, loopReason, parseAuthenticationResults } from './headers';

const verdict = (raw: Buffer, domain = 'example.com', ids = [TRUSTED_ID]) => authenticationVerdict(headerLines(raw), domain, ids);

describe('authentication', () => {
  test('a DMARC pass for the From domain under the trusted id passes', () => {
    expect(verdict(rawMail())).toMatchObject({ ok: true, method: 'dmarc' });
  });

  test('fails closed: no header, an untrusted id, no trusted ids configured', () => {
    expect(verdict(rawMail({ auth: null }))).toEqual({ ok: false, why: 'no_trusted_results' });
    expect(verdict(rawMail({ auth: 'mx.evil.test; dmarc=pass header.from=example.com' }))).toEqual({ ok: false, why: 'no_trusted_results' });
    expect(verdict(rawMail(), 'example.com', [])).toEqual({ ok: false, why: 'no_trusted_results' });
  });

  test('only the topmost trusted header counts: a pass the sender wrote below the real one is ignored', () => {
    const forged = rawMail({
      auth: `${TRUSTED_ID}; spf=fail smtp.mailfrom=evil.test; dkim=none; dmarc=fail header.from=example.com`,
      below: [`Authentication-Results: ${TRUSTED_ID}; dmarc=pass header.from=example.com`],
    });
    expect(verdict(forged)).toEqual({ ok: false, why: 'dmarc_not_pass' });
  });

  test('a DMARC pass for another domain does not vouch for this From', () => {
    expect(verdict(rawMail({ auth: `${TRUSTED_ID}; dmarc=pass header.from=evil.test` }))).toEqual({ ok: false, why: 'dmarc_not_pass' });
  });

  test('without DMARC, an aligned DKIM or SPF pass passes; an unaligned one does not', () => {
    expect(verdict(rawMail({ auth: `${TRUSTED_ID}; dkim=pass header.d=example.com` }))).toMatchObject({ ok: true, method: 'dkim' });
    expect(verdict(rawMail({ auth: `${TRUSTED_ID}; spf=pass smtp.mailfrom=bounce@mail.example.com` }), 'mail.example.com')).toMatchObject({ ok: true, method: 'spf' });
    expect(verdict(rawMail({ auth: `${TRUSTED_ID}; dkim=pass header.d=evil.test; spf=pass smtp.mailfrom=evil.test` }))).toEqual({ ok: false, why: 'no_aligned_pass' });
  });

  test('parsing: comments, version, quoted values; a one-label domain never aligns', () => {
    expect(parseAuthenticationResults('MX.Test 1; dkim=pass (good sig) header.d="Example.com"')).toEqual({
      authservId: 'mx.test', results: [{ method: 'dkim', result: 'pass', props: { 'header.d': 'example.com' } }],
    });
    expect(aligned('com', 'example.com')).toBe(false);
    expect(aligned('example.com', 'sub.example.com')).toBe(true);
    expect(aligned('sub.example.com', 'example.com')).toBe(false);
  });
});

describe('loop guards', () => {
  const reason = (raw: Buffer, from = 'ann@example.com') => loopReason(headerLines(raw), from, 'octipus@company.test');

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
