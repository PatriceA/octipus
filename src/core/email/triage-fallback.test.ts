/** A triage run or preview that names an account in the request runs on that account, not the default. */
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/security/oauth', () => ({
  normalizeAccount: (v: unknown) => (typeof v === 'string' && v.includes('@') ? v.toLowerCase() : null),
  getOAuthManager: () => ({ accountRole: async (_u: string, _p: string, a: string) => (a === 'b@y.example' ? 'other' : a === 'a@x.example' ? 'default' : null) }),
}));
vi.mock('./mailbox', () => ({ resolveProvider: async (_u: string, p: string | null) => (p ?? 'google') }));
vi.mock('./imap-mailbox', () => ({}));

const repos = {} as never;
const row = (id: string) => ({ id, from: { email: 's@x.org' }, subject: 's', snippet: '' });

describe('the mailbox of rows that name none', () => {
  test('is the account the request named', async () => {
    const { fallbackMailbox, triageSources } = await import('./triage-sources');
    const { inMailbox } = await import('./account-context');
    const fallback = await inMailbox({ provider: 'google', account: 'b@y.example' }, () => fallbackMailbox(repos, 'u1', 'google'));
    expect(fallback).toEqual({ key: 'google:b@y.example', mailbox: 'google' });

    const [rows] = await triageSources(repos, 'u1', { fallback: fallback!.key, items: [row('m1')] });
    expect(rows).toMatchObject({ mailbox: 'google', selection: { provider: 'google', account: 'b@y.example' } });
    expect(rows.items?.[0]).toMatchObject({ id: 'm1', account: 'b@y.example' });

    const [newest] = await triageSources(repos, 'u1', { fallback: fallback!.key });
    expect(newest).toMatchObject({ mailbox: 'google', selection: { provider: 'google', account: 'b@y.example' } });
  });

  test('is the default account when the request named none', async () => {
    const { fallbackMailbox, triageSources } = await import('./triage-sources');
    const { inMailbox } = await import('./account-context');
    const fallback = await inMailbox(null, () => fallbackMailbox(repos, 'u1', 'google'));
    expect(fallback).toEqual({ key: 'google', mailbox: 'google' });
    const [source] = await triageSources(repos, 'u1', { fallback: fallback!.key, items: [row('m1')] });
    expect(source).toMatchObject({ mailbox: 'google', selection: null });
  });
});
