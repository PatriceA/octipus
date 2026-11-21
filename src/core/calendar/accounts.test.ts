/**
 * Calendars of several accounts of one provider: each account's calendars
 * are listed and read with that account's own token, carry the account, and
 * are named apart in stored choices — while the default account's calendars
 * keep the names they always had.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: vi.fn(async () => null), update: vi.fn() } }));
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ getValidToken: async () => null }) }));

import { calendarKey } from '@/shared/calendar';
import { applyVisibility, listCalendars, validateCalendarPreferences } from './calendars';
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
        { provider: 'google', id: 'primary-home', name: 'Home' },
        { provider: 'google', id: 'primary-work', name: 'Work', account: 'me@work.example' },
      ],
    });
    expect(urls.map((u) => [u.token, u.url.includes('primary-work') ? 'work' : 'home'])).toEqual(expect.arrayContaining([['token:home', 'home'], ['token:me@work.example', 'work']]));
    expect(result.events.map((e) => [e.id, e.account])).toEqual(expect.arrayContaining([
      ['token:home:primary-home', undefined],
      ['token:me@work.example:primary-work', 'me@work.example'],
    ]));
  });
});
