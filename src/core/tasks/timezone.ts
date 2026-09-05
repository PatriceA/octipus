/**
 * Which timezone a user's "today" is in. The browser knows best (it reports
 * its zone as `?tz=`); otherwise the user's saved preference; otherwise UTC,
 * never the server's zone — a Docker host in UTC must not decide when a
 * consultant in Berlin has a task "due today".
 */
import { userRepository } from '@/db/repositories/user-repository';
import { isValidTimezone } from './rank';

export async function resolveUserTimezone(userId: string, override?: string | null): Promise<string> {
  if (isValidTimezone(override)) return override;
  const user = await userRepository.findById(userId);
  const preferred = user?.preferences?.timezone;
  return isValidTimezone(preferred) ? preferred : 'UTC';
}
