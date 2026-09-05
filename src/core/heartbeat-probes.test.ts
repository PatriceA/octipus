import { describe, expect, test } from 'vitest';
import {
  parseFailingPullRequests,
  parseGoogleEvents,
  parseGraphEvents,
  probeFailingPullRequests,
  probeUpcomingEvents,
} from './heartbeat-probes';

const NOW = new Date('2026-09-07T09:00:00Z');
const UNTIL = new Date('2026-09-07T10:00:00Z');

const pr = (over: Record<string, unknown>) => ({
  number: 1, title: 'Fix', url: 'https://github.com/o/r/pull/1', isDraft: false,
  repository: { nameWithOwner: 'o/r' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
});

describe('parseFailingPullRequests', () => {
  test('keeps FAILURE and ERROR rollups, drops green, pending and unchecked', () => {
    const out = parseFailingPullRequests({ data: { search: { nodes: [
      pr({ number: 1, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
      pr({ number: 2, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] } }),
      pr({ number: 3 }),
      pr({ number: 4, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }),
      pr({ number: 5, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
      {}, // an Issue node from the search union has no PR fields
    ] } } });
    expect(out.map((p) => p.number)).toEqual([1, 2]);
    expect(out[0]).toEqual({ repo: 'o/r', number: 1, title: 'Fix', url: 'https://github.com/o/r/pull/1', state: 'FAILURE' });
  });
  test('a draft with red checks is work in progress, not a failure', () => {
    const out = parseFailingPullRequests({ data: { search: { nodes: [
      pr({ number: 9, isDraft: true, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
    ] } } });
    expect(out).toEqual([]);
  });
  test('tolerates a malformed response', () => {
    expect(parseFailingPullRequests(null)).toEqual([]);
    expect(parseFailingPullRequests({ errors: [{ message: 'bad' }] })).toEqual([]);
  });
});

describe('probeFailingPullRequests', () => {
  test('sends the search query to gh and parses the reply', async () => {
    const calls: string[][] = [];
    const out = await probeFailingPullRequests({
      runGh: async (args) => { calls.push(args); return JSON.stringify({ data: { search: { nodes: [pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } })] } } }); },
    });
    expect(calls[0].slice(0, 3)).toEqual(['api', 'graphql', '-f']);
    expect(calls[0][3]).toContain('author:@me');
    expect(out).toHaveLength(1);
  });
  test('an absent or failing gh yields null (unavailable), never a throw and never "nothing red"', async () => {
    expect(await probeFailingPullRequests({ runGh: async () => { throw new Error('spawn gh ENOENT'); } })).toBeNull();
    expect(await probeFailingPullRequests({ runGh: async () => 'not json' })).toBeNull();
    expect(await probeFailingPullRequests({ runGh: async () => JSON.stringify({ data: { search: { nodes: [] } } }) })).toEqual([]);
  });
});

describe('parseGoogleEvents', () => {
  test('keeps timed events in the window; drops all-day, cancelled and out-of-window', () => {
    const out = parseGoogleEvents({ items: [
      { summary: 'Standup', start: { dateTime: '2026-09-07T09:15:00Z' }, end: { dateTime: '2026-09-07T09:30:00Z' } },
      { summary: 'Offsite', start: { date: '2026-09-07' } },
      { summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-09-07T09:20:00Z' } },
      { summary: 'Later', start: { dateTime: '2026-09-07T11:00:00Z' } },
      { summary: 'Already started', start: { dateTime: '2026-09-07T08:30:00Z' } },
      { start: { dateTime: '2026-09-07T09:45:00+02:00' } }, // 07:45Z → before now
    ] }, NOW, UNTIL);
    expect(out).toEqual([{ title: 'Standup', start: '2026-09-07T09:15:00.000Z', end: '2026-09-07T09:30:00.000Z', provider: 'google' }]);
  });
});

describe('parseGraphEvents', () => {
  test('a zone-less time in a non-UTC zone is skipped rather than guessed', () => {
    const out = parseGraphEvents({ value: [
      { subject: 'Guess me', start: { dateTime: '2026-09-07T09:30:00.0000000', timeZone: 'Pacific Standard Time' } },
      { subject: 'Explicit offset', start: { dateTime: '2026-09-07T11:30:00+02:00', timeZone: 'W. Europe Standard Time' } },
    ] }, NOW, UNTIL);
    expect(out.map((e) => e.title)).toEqual(['Explicit offset']);
  });

  test('reads Graph\'s zone-less UTC dateTime and applies the same window rules', () => {
    const out = parseGraphEvents({ value: [
      { subject: 'Review', start: { dateTime: '2026-09-07T09:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-09-07T10:00:00.0000000', timeZone: 'UTC' } },
      { subject: 'All day', isAllDay: true, start: { dateTime: '2026-09-07T00:00:00.0000000', timeZone: 'UTC' } },
      { subject: 'Gone', isCancelled: true, start: { dateTime: '2026-09-07T09:40:00.0000000', timeZone: 'UTC' } },
      { subject: 'Tomorrow', start: { dateTime: '2026-09-08T09:00:00.0000000', timeZone: 'UTC' } },
    ] }, NOW, UNTIL);
    expect(out).toEqual([{ title: 'Review', start: '2026-09-07T09:30:00.000Z', end: '2026-09-07T10:00:00.000Z', provider: 'microsoft' }]);
  });
});

describe('probeUpcomingEvents', () => {
  test('asks only the providers that have a token, merges and sorts', async () => {
    const urls: string[] = [];
    const out = await probeUpcomingEvents('u1', NOW, 60, {
      getToken: async (_u, provider) => (provider === 'google' ? 'g-token' : 'm-token'),
      fetchJson: async (url, headers) => {
        urls.push(url);
        if (url.includes('googleapis')) {
          expect(headers.Authorization).toBe('Bearer g-token');
          return { items: [{ summary: 'Late', start: { dateTime: '2026-09-07T09:50:00Z' } }] };
        }
        expect(headers.Prefer).toContain('UTC');
        return { value: [{ subject: 'Early', start: { dateTime: '2026-09-07T09:10:00.0000000', timeZone: 'UTC' } }] };
      },
    });
    expect(out.events.map((e) => [e.title, e.provider])).toEqual([['Early', 'microsoft'], ['Late', 'google']]);
    expect(out.partial).toBe(false);
    expect(urls.some((u) => u.includes('timeMin=2026-09-07T09%3A00%3A00.000Z'))).toBe(true);
    expect(urls.some((u) => u.includes('calendarView?startDateTime='))).toBe(true);
  });
  test('no token → no request; a provider error → that provider is skipped and the result is marked partial', async () => {
    let fetched = 0;
    const none = await probeUpcomingEvents('u1', NOW, 60, { getToken: async () => null, fetchJson: async () => { fetched += 1; return {}; } });
    expect(none).toEqual({ events: [], partial: false });
    expect(fetched).toBe(0);
    const partial = await probeUpcomingEvents('u1', NOW, 60, {
      getToken: async () => 'tok',
      fetchJson: async (url) => { if (url.includes('googleapis')) throw new Error('503'); return { value: [{ subject: 'Ok', start: { dateTime: '2026-09-07T09:10:00', timeZone: 'UTC' } }] }; },
    });
    expect(partial.events.map((e) => e.title)).toEqual(['Ok']);
    expect(partial.partial).toBe(true);
  });
});
