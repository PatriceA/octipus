import { describe, expect, test } from 'vitest';
import { accountKey } from './triage-sources';

describe('mailbox keys of a triage run', () => {
  test('a further account is provider:address; the default account and IMAP keys are not accounts', () => {
    expect(accountKey('google:me@work.example')).toEqual({ provider: 'google', account: 'me@work.example' });
    expect(accountKey('microsoft:ana@contoso.com')).toEqual({ provider: 'microsoft', account: 'ana@contoso.com' });
    expect(accountKey('google')).toBeNull();
    // An IMAP id never holds "@": the two kinds of key cannot be taken for each other.
    expect(accountKey('imap:3f2b1c9e-0000-4000-8000-000000000001')).toBeNull();
    expect(accountKey('google:not-an-address')).toBeNull();
    expect(accountKey('yahoo:me@x.org')).toBeNull();
  });
});
