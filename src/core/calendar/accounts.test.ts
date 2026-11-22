/**
 * Calendars of several accounts of one provider: each account's calendars
 * are listed and read with that account's own token, carry the account, and
 * are named apart in stored choices — while the default account's calendars
 * keep the names they always had.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: vi.fn(async () => null), update: vi.fn() } }));
/** Google accounts as the OAuth manager has them; `changed` is what it tells listeners of account changes. */
const oauth = vi.hoisted(() => ({ accounts: [] as string[], listeners: new Set<(userId: string, provider: string) => void>() }));
vi.mock('@/security/oauth', () => ({
  getOAuthManager: () => ({
    getValidToken: async (_u: string, provider: string, account?: string) => (provider === 'google' && oauth.accounts.length && (!account || oauth.accounts.includes(account)) ? `token:${account ?? oauth.accounts[0]}` : null),
    listAccounts: async (_u: string, provider: string) => (provider === 'google' ? oauth.accounts.map((account, i) => ({ provider, account, isDefault: i === 0 })) : []),
  }),
  onAccountsChanged: (listener: (userId: string, provider: string) => void) => { oauth.listeners.add(listener); return () => oauth.listeners.delete(listener); },
}));

import { calendarKey } from '@/shared/calendar';
import { applyVisibility, calendarView, listCalendars, validateCalendarPreferences } from './calendars';
import { type CalendarDeps, listCalendarEvents } from './events';

const list = (id: string, name: string, primary = false) => ({ items: [{ id, summary: name, primary, accessRole: 'owner', selected: true }] });
const event = (id: string) => ({ items: [{ id, summary: id, start: { dateTime: '2026-11-04T08:00:00Z' }, end: { dateTime: '2026-11-04T09:00:00Z' } }] });

/** Google with two accounts: the token names the account, and each account answers with its own calendars. */
function twoAccounts(urls: Array<{ url: string; token: string }>): CalendarDeps {
  return {
    getToken: async (_u, provider, account) => (provider === 'google' ? `token:${account ?? 'home'}` : null),
    otherAccounts: async (_u, provider) => (provider === 'google' ? ['me@work.example'] : []),
    fetchJson: async (url, headers) => {
      const token = headers.Authorization.replace('Bearer ', '');
      urls.push({ url, token });
      if (url.includes('calendarList')) return token === 'token:home' ? list('primary-home', 'Home', true) : list('primary-work', 'Work', true);
      return event(`${token}:${decodeURIComponent(url.split('/calendars/')[1].split('/')[0])}`);
    },
  };
}

describe('several accounts of one provider', () => {
  it('a calendar of a further account is named with its account; the default account\'s keep their names', () => {
    expect(calendarKey({ provider: 'google', id: 'cal' })).toBe('google:cal');
    expect(calendarKey({ provider: 'google', id: 'cal', account: 'me@work.example' })).toBe('google:me@work.example:cal');
    expect(validateCalendarPreferences({ visible: ['google:me@work.example:cal'] })).toEqual({ visible: ['google:me@work.example:cal'] });
  });

  it('lists every account\'s calendars, each read with its own token; a further account\'s carry it', async () => {
    const urls: Array<{ url: string; token: string }> = [];
    const result = await listCalendars('alice', twoAccounts(urls));
    expect(result.calendars.map((c) => [c.name, c.account])).toEqual([['Home', undefined], ['Work', 'me@work.example']]);
    expect(urls.map((u) => u.token)).toEqual(['token:home', 'token:me@work.example']);
    expect(result.partial).toBe(false);
    // The same calendar id in two accounts is two calendars to tick.
    const visible = applyVisibility(result.calendars, { visible: ['google:me@work.example:primary-work'] });
    expect(visible.map((c) => c.visible)).toEqual([false, true]);
  });

  it('a further account that cannot be read makes the list partial without hiding the default account', async () => {
    const urls: Array<{ url: string; token: string }> = [];
    const deps = twoAccounts(urls);
    const result = await listCalendars('alice', { ...deps, getToken: async (_u, p, account) => (p === 'google' && !account ? 'token:home' : null) });
    expect(result.calendars.map((c) => c.name)).toEqual(['Home']);
    expect(result.providers).toEqual(['google']);
    expect(result.partial).toBe(true);
  });

  it('events of a further account\'s calendar are read with that account\'s token and say which account they are from', async () => {
    const urls: Array<{ url: string; token: string }> = [];
    const result = await listCalendarEvents('alice', {
      from: new Date('2026-11-01'), to: new Date('2026-11-08'), deps: twoAccounts(urls),
      calendars: [
        { provider: 'google', id: 'primary-home', name: 'Home', readOnly: false },
        { provider: 'google', id: 'primary-work', name: 'Work', readOnly: false, account: 'me@work.example' },
      ],
    });
    expect(urls.map((u) => [u.token, u.url.includes('primary-work') ? 'work' : 'home'])).toEqual(expect.arrayContaining([['token:home', 'home'], ['token:me@work.example', 'work']]));
    expect(result.events.map((e) => [e.id, e.account])).toEqual(expect.arrayContaining([
      ['token:home:primary-home', undefined],
      ['token:me@work.example:primary-work', 'me@work.example'],
    ]));
  });
});

describe('the kept calendar list', () => {
  it('is dropped when the user\'s connected accounts change, so a new default\'s calendars are listed as its own', async () => {
    // Each account's token answers with that account's own primary calendar.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const token = String(new Headers(init?.headers).get('authorization')).replace('Bearer token:', '');
      return new Response(JSON.stringify(list(`primary-${token}`, token, true)));
    }));
    try {
      oauth.accounts = ['me@home.example', 'me@work.example'];
      const names = async () => (await calendarView('carol')).calendars.map((c) => [c.id, c.account]);
      expect(await names()).toEqual([['primary-me@home.example', undefined], ['primary-me@work.example', 'me@work.example']]);
      // "Make default" on work: until the kept list goes, home's calendar would be read with work's token.
      oauth.accounts = ['me@work.example', 'me@home.example'];
      for (const listener of oauth.listeners) listener('carol', 'google');
      expect(await names()).toEqual([['primary-me@work.example', undefined], ['primary-me@home.example', 'me@home.example']]);
      // A third account connected: its calendar appears at once.
      oauth.accounts = ['me@work.example', 'me@home.example', 'me@club.example'];
      for (const listener of oauth.listeners) listener('carol', 'google');
      expect((await names()).map(([id]) => id)).toContain('primary-me@club.example');
      // Another user's change leaves this user's kept list alone.
      oauth.accounts = [];
      for (const listener of oauth.listeners) listener('dave', 'google');
      expect(await names()).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
