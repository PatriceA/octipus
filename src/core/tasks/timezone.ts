/**
 * Which timezone a user's "today" is in. The browser knows best (it reports
 * its zone as `?tz=`); otherwise the user's saved preference; otherwise UTC,
 * never the server's zone — a Docker host in UTC must not decide when a
 * consultant in Berlin has a task "due today".
 */
import { userRepository } from '@/db/repositories/user-repository';
import { dateOnlyToEndOfDay, dateOnlyToStartOfDay, isValidTimezone } from './rank';

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
