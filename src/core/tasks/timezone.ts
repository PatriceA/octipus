/**
 * Which timezone a user's "today" is in. The browser knows best (it reports
 * its zone as `?tz=`); otherwise the user's saved preference; otherwise UTC,
 * never the server's zone — a Docker host in UTC must not decide when a
 * consultant in Berlin has a task "due today".
 */
import { userRepository } from '@/db/repositories/user-repository';
import { dateOnlyToEndOfDay, dateOnlyToStartOfDay, isValidTimezone } from './rank';

/**
 * A zone that is only an offset (`Etc/GMT-1`, `UTC`, `GMT`): what the mobile
 * app can report, built from the phone's current offset. Fine for "today" in
 * one request; wrong for anything long-lived, since it does not follow DST.
 */
export function isFixedOffsetZone(tz: string): boolean {
  return /^(etc\/.*|utc|gmt|z|zulu|universal|uct|greenwich)$/i.test(tz.trim());
}

/**
 * Remember the zone a device reported (the web sends the browser's IANA zone,
 * the mobile app a fixed offset), so agent work, `/todo`, repeats and
 * reminders read the user's day instead of UTC. Written only when it helps:
 *   - never over a zone the user chose in Settings (`timezoneSource: 'user'`);
 *   - never a fixed offset over a named zone (Berlin stays Berlin when the
 *     phone reports `Etc/GMT-1`); a named zone does replace a fixed one;
 *   - otherwise when it differs (a laptop that travelled).
 * Returns whether it wrote. A failed write is logged by the caller's path, not here.
 */
export async function rememberDeviceTimezone(userId: string, tz: string | null | undefined): Promise<boolean> {
  if (!isValidTimezone(tz)) return false;
  // The rules are the UPDATE's condition: a choice made in Settings between a read and a write is never replaced.
  return userRepository.setDeviceTimezone(userId, tz, isFixedOffsetZone(tz));
}

/**
 * The zone for something long-lived (a repeat series): the stored named zone
 * first, then a named zone the request reported, then whatever is stored or
 * reported, then UTC. A fixed offset is a last resort because it ignores DST.
 */
export async function resolveSeriesTimezone(userId: string, requested?: string | null): Promise<string> {
  const user = await userRepository.findById(userId);
  const stored = user?.preferences?.timezone;
  for (const candidate of [stored, requested]) {
    if (isValidTimezone(candidate) && !isFixedOffsetZone(candidate)) return candidate;
  }
  for (const candidate of [stored, requested]) if (isValidTimezone(candidate)) return candidate;
  return 'UTC';
}

export async function resolveUserTimezone(userId: string, override?: string | null): Promise<string> {
  if (isValidTimezone(override)) return override;
  const user = await userRepository.findById(userId);
  const preferred = user?.preferences?.timezone;
  return isValidTimezone(preferred) ? preferred : 'UTC';
}

/**
 * A task date from user or agent input. ISO 8601 is taken as written; a bare
 * `YYYY-MM-DD` is a day in the user's zone — its end for a due date (due
 * "today" is not overdue until the day is over), its start for a follow-up
 * (the reminder comes back that day, not the evening before). Throws on
 * anything else, so a reminder is never silently dropped.
 */
export async function parseTaskDate(
  value: string,
  field: 'dueAt' | 'remindAt',
  userId: string,
  tz?: string | null,
): Promise<Date> {
  const zone = await resolveUserTimezone(userId, tz);
  const dateOnly = field === 'dueAt' ? dateOnlyToEndOfDay(value, zone) : dateOnlyToStartOfDay(value, zone);
  if (dateOnly) return dateOnly;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${field} "${value}" — expected an ISO 8601 date`);
  return d;
}
