import { describe, expect, test } from 'vitest';
import type { HeartbeatConfig } from '@/config/schema';
import {
  type HeartbeatProbe,
  heartbeatRole,
  isWithinQuietHours,
  localDayKey,
  localHour,
  probeHasWork,
  renderChecklist,
  renderRoleHeartbeatMessage,
  sanitizeTriggerConfig,
} from './heartbeat';

const cfg = (over: Partial<HeartbeatConfig> = {}): HeartbeatConfig => ({
  enabled: true,
  intervalMinutes: 60,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietHoursTimezone: 'UTC',
  maxRunsPerDay: 24,
  probeGithub: true,
  probeCalendar: true,
  calendarLookaheadMinutes: 60,
  ...over,
});

/** A probe literal with the two external sources empty unless given. */
const probe = (over: Partial<HeartbeatProbe> = {}): HeartbeatProbe => ({
  dueTasks: [],
  unreadNotifications: [],
  failingPullRequests: [],
  upcomingEvents: [],
  ...over,
});

describe('localHour / localDayKey (tz-aware)', () => {
  test('localHour respects the timezone', () => {
    const t = new Date('2026-07-12T05:00:00Z');
    expect(localHour(t, 'UTC')).toBe(5);
    // America/New_York is UTC-4 in July → 01:00 local.
    expect(localHour(t, 'America/New_York')).toBe(1);
  });

  test('localHour falls back to UTC on a bad tz', () => {
    const t = new Date('2026-07-12T09:00:00Z');
    expect(localHour(t, 'Not/AZone')).toBe(9);
  });

  test('localDayKey rolls the date at the tz midnight', () => {
    const t = new Date('2026-07-12T02:00:00Z');
    expect(localDayKey(t, 'UTC')).toBe('2026-07-12');
    // 02:00 UTC is still 2026-07-11 in New York (22:00 prev day).
    expect(localDayKey(t, 'America/New_York')).toBe('2026-07-11');
  });
});

describe('isWithinQuietHours', () => {
  test('midnight-wrapping window (22→7)', () => {
    expect(isWithinQuietHours(cfg(), new Date('2026-07-12T23:30:00Z'))).toBe(true); // 23h
    expect(isWithinQuietHours(cfg(), new Date('2026-07-12T03:00:00Z'))).toBe(true); // 3h
    expect(isWithinQuietHours(cfg(), new Date('2026-07-12T07:00:00Z'))).toBe(false); // 7h = end (exclusive)
    expect(isWithinQuietHours(cfg(), new Date('2026-07-12T12:00:00Z'))).toBe(false); // noon
  });

  test('same-day window (1→5)', () => {
    const c = cfg({ quietHoursStart: 1, quietHoursEnd: 5 });
    expect(isWithinQuietHours(c, new Date('2026-07-12T02:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(c, new Date('2026-07-12T05:00:00Z'))).toBe(false);
    expect(isWithinQuietHours(c, new Date('2026-07-12T23:00:00Z'))).toBe(false);
  });

  test('equal start/end disables quiet hours', () => {
    const c = cfg({ quietHoursStart: 0, quietHoursEnd: 0 });
    expect(isWithinQuietHours(c, new Date('2026-07-12T00:00:00Z'))).toBe(false);
    expect(isWithinQuietHours(c, new Date('2026-07-12T12:00:00Z'))).toBe(false);
  });

  test('window is evaluated in the configured timezone', () => {
    // 05:00 UTC = 01:00 New York → inside 22→7.
    const c = cfg({ quietHoursTimezone: 'America/New_York' });
    expect(isWithinQuietHours(c, new Date('2026-07-12T05:00:00Z'))).toBe(true);
    // 15:00 UTC = 11:00 New York → outside.
    expect(isWithinQuietHours(c, new Date('2026-07-12T15:00:00Z'))).toBe(false);
  });
});

describe('probeHasWork', () => {
  test('empty probe = no work', () => {
    expect(probeHasWork(probe())).toBe(false);
  });
  test('any signal = work', () => {
    expect(probeHasWork(probe({ dueTasks: [{ title: 't', dueAt: new Date() }] }))).toBe(true);
    expect(probeHasWork(probe({ unreadNotifications: [{ title: 'n', type: 'x' }] }))).toBe(true);
    expect(probeHasWork(probe({ failingPullRequests: [{ repo: 'o/r', number: 1, title: 't', url: 'u', state: 'FAILURE' }] }))).toBe(true);
    expect(probeHasWork(probe({ upcomingEvents: [{ title: 'e', start: '2026-07-12T12:30:00.000Z', provider: 'google' }] }))).toBe(true);
  });
});

describe('renderChecklist', () => {
  test('formats due tasks and unread notifications', () => {
    const p = probe({
      dueTasks: [{ title: 'Ship WS2', dueAt: new Date('2026-07-12T00:00:00Z') }],
      unreadNotifications: [{ title: 'PR approved', type: 'github' }],
    });
    const out = renderChecklist(p);
    expect(out).toContain('Due tasks (1):');
    expect(out).toContain('- Ship WS2 (due 2026-07-12)');
    expect(out).toContain('Unread notifications (1):');
    expect(out).toContain('- [github] PR approved');
  });

  test('omits a section with no items', () => {
    const out = renderChecklist(probe({ unreadNotifications: [{ title: 'x', type: 't' }] }));
    expect(out).not.toContain('Due tasks');
    expect(out).toContain('Unread notifications (1):');
  });

  test('events and failing PRs come first — they are the time-critical ones', () => {
    const out = renderChecklist(probe({
      dueTasks: [{ title: 'Ship', dueAt: null }],
      failingPullRequests: [{ repo: 'o/r', number: 7, title: 'Fix CI', url: 'https://github.com/o/r/pull/7', state: 'FAILURE' }],
      upcomingEvents: [{ title: 'Standup', start: '2026-07-12T12:15:00.000Z', end: '2026-07-12T12:30:00.000Z', provider: 'google' }],
    }));
    const sections = out.split('\n').filter((l) => /^[A-Z].*\(\d+[^)]*\):$/.test(l));
    expect(sections).toEqual(['Starting soon (1, times in UTC):', 'Pull requests with failing checks (1):', 'Due tasks (1):']);
    expect(out).toContain('- 12:15 Standup (until 12:30)');
    expect(out).toContain('- o/r#7 Fix CI — https://github.com/o/r/pull/7');
  });

  test('event times are rendered in the user\'s zone, not UTC', () => {
    const out = renderChecklist(probe({
      upcomingEvents: [{ title: 'Client call', start: '2026-07-12T16:30:00.000Z', end: '2026-07-12T17:00:00.000Z', provider: 'google' }],
    }), 'America/Los_Angeles');
    expect(out).toContain('Starting soon (1, times in America/Los_Angeles):');
    expect(out).toContain('- 09:30 Client call (until 10:00)');
  });
});

describe('role heartbeats (pure)', () => {
  test('heartbeatRole reads triggerConfig.role on heartbeat hooks only', () => {
    expect(heartbeatRole({ trigger: 'heartbeat', triggerConfig: { role: 'coding' } })).toBe('coding');
    expect(heartbeatRole({ trigger: 'heartbeat', triggerConfig: {} })).toBeNull();
    expect(heartbeatRole({ trigger: 'heartbeat', triggerConfig: null })).toBeNull();
    expect(heartbeatRole({ trigger: 'schedule', triggerConfig: { role: 'coding' } })).toBeNull();
    // Not a role name: never reaches a query or a spawn.
    expect(heartbeatRole({ trigger: 'heartbeat', triggerConfig: { role: "coding' OR 1=1" } })).toBeNull();
  });

  test('the role message lists ids and titles and the checkout-first protocol', () => {
    const out = renderRoleHeartbeatMessage('coding', [
      { id: '00000000-0000-0000-0000-00000000000a', title: 'Fix the login bug' },
      { id: '00000000-0000-0000-0000-00000000000b', title: 'Add retries' },
    ]);
    expect(out).toContain('you are the `coding` agent');
    expect(out).toContain('- 00000000-0000-0000-0000-00000000000a — Fix the login bug');
    expect(out).toContain('- 00000000-0000-0000-0000-00000000000b — Add retries');
    const checkout = out.indexOf('`checkout_task`');
    expect(checkout).toBeGreaterThan(-1);
    expect(out).toContain('409');
    expect(out.indexOf('`add_task_comment`')).toBeGreaterThan(checkout);
    expect(out.indexOf('`complete_task`')).toBeGreaterThan(checkout);
  });

  test('the role message caps the list and says how many wait', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `id-${i}`, title: `T${i}` }));
    const out = renderRoleHeartbeatMessage('qa', many);
    expect(out).toContain('- id-19 — T19');
    expect(out).not.toContain('- id-20 — T20');
    expect(out).toContain('(5 more;');
  });
});

describe('sanitizeTriggerConfig', () => {
  test('drops the server-held heartbeat state from user input', () => {
    const out = sanitizeTriggerConfig({
      role: 'coding', heartbeatDayKey: '2026-07-12', heartbeatRunsToday: 0, heartbeatSeen: { prs: [] }, heartbeatPermissionNotified: true,
      heartbeatInFlightUntil: '2099-01-01T00:00:00Z', heartbeatInFlightToken: 'forged',
    });
    expect(out).toEqual({ role: 'coding' });
  });

  test('an edit keeps the stored state whatever it sends', () => {
    const stored = { role: 'coding', heartbeatDayKey: '2026-07-12', heartbeatRunsToday: 24 };
    expect(sanitizeTriggerConfig({ role: 'qa', heartbeatRunsToday: 0 }, stored)).toEqual({ role: 'qa', heartbeatDayKey: '2026-07-12', heartbeatRunsToday: 24 });
    const leased = { role: 'coding', heartbeatInFlightUntil: '2026-07-12T13:00:00Z', heartbeatInFlightToken: 'mine' };
    expect(sanitizeTriggerConfig({ role: 'coding', heartbeatInFlightToken: 'theirs' }, leased)).toEqual(leased);
  });

  test('non-object input becomes an empty config', () => {
    expect(sanitizeTriggerConfig(null)).toEqual({});
    expect(sanitizeTriggerConfig([1, 2])).toEqual({});
  });
});
