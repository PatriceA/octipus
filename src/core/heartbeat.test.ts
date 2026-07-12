import { describe, expect, test } from 'bun:test';
import type { HeartbeatConfig } from '@/config/schema';
import {
  type HeartbeatProbe,
  isWithinQuietHours,
  localDayKey,
  localHour,
  probeHasWork,
  renderChecklist,
} from './heartbeat';

const cfg = (over: Partial<HeartbeatConfig> = {}): HeartbeatConfig => ({
  enabled: true,
  intervalMinutes: 60,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietHoursTimezone: 'UTC',
  maxRunsPerDay: 24,
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
    expect(probeHasWork({ dueTasks: [], unreadNotifications: [] })).toBe(false);
  });
  test('any signal = work', () => {
    expect(probeHasWork({ dueTasks: [{ title: 't', dueAt: new Date() }], unreadNotifications: [] })).toBe(true);
    expect(probeHasWork({ dueTasks: [], unreadNotifications: [{ title: 'n', type: 'x' }] })).toBe(true);
  });
});

describe('renderChecklist', () => {
  test('formats due tasks and unread notifications', () => {
    const p: HeartbeatProbe = {
      dueTasks: [{ title: 'Ship WS2', dueAt: new Date('2026-07-12T00:00:00Z') }],
      unreadNotifications: [{ title: 'PR approved', type: 'github' }],
    };
    const out = renderChecklist(p);
    expect(out).toContain('Due tasks (1):');
    expect(out).toContain('- Ship WS2 (due 2026-07-12)');
    expect(out).toContain('Unread notifications (1):');
    expect(out).toContain('- [github] PR approved');
  });

  test('omits a section with no items', () => {
    const out = renderChecklist({ dueTasks: [], unreadNotifications: [{ title: 'x', type: 't' }] });
    expect(out).not.toContain('Due tasks');
    expect(out).toContain('Unread notifications (1):');
  });
});
