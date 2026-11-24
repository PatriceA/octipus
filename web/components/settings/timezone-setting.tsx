'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { UserProfile } from '@/lib/types/settings';

function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function allZones(current: string | undefined): string[] {
  const listed = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set([...(current ? [current] : []), browserZone(), 'UTC', ...listed])].sort((a, b) => a.localeCompare(b));
}

/**
 * The zone of the user's day: what "today", My Day, repeating to-dos and
 * `/todo` read. Devices report theirs (PUT /auth/timezone `device`); choosing
 * one here fixes it (`user`) until "Follow this device" is ticked again.
 */
export function TimezoneSetting({ profile }: { profile: UserProfile | undefined }) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const stored = profile?.preferences?.timezone;
  const follows = profile?.preferences?.timezoneSource !== 'user';
  const save = async (timezone: string, source: 'user' | 'follow') => {
    setError('');
    try {
      await api.put('/auth/timezone', { timezone, source });
      await client.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="space-y-2 rounded-lg bg-surface-container-low p-4" data-testid="timezone-setting">
      <label className="flex flex-wrap items-center justify-between gap-4">
        <span className="font-medium text-on-surface">Time zone</span>
        <select aria-label="Time zone" disabled={!profile} value={stored ?? browserZone()} onChange={(e) => void save(e.target.value, 'user')}
          className="rounded-md border border-outline-variant px-3 py-2 text-sm">
          {allZones(stored).map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-on-surface-variant">
        <input type="checkbox" checked={follows} disabled={!profile} onChange={(e) => { if (e.target.checked) void save(browserZone(), 'follow'); else void save(stored ?? browserZone(), 'user'); }} />
        Follow this device ({browserZone()})
      </label>
      <p className="text-sm text-on-surface-variant">Decides when your day starts: My Day, due “today”, repeating to-dos and dates you type in chat. A phone that only knows its offset never replaces a named zone.</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
    </div>
  );
}
