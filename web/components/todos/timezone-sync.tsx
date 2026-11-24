'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * Tell the server this browser's zone once per page load (PUT /auth/timezone
 * `device`). The server keeps it only when it helps — no zone stored yet, or
 * a device-reported one that differs; never over one chosen in Settings — so
 * agent work, `/todo`, repeats and reminders read the user's day, not UTC.
 */
export function TimezoneSync() {
  const { isAuthenticated, user } = useAuth();
  const userId = user?.id;
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    api.put('/auth/timezone', { timezone, source: 'device' }).catch((err: Error) => console.warn('Could not report the time zone', err.message));
  }, [isAuthenticated, userId]);
  return null;
}
