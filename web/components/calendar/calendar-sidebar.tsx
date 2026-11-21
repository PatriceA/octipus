'use client';

import { ChevronLeft, ChevronRight, Lock, Users } from 'lucide-react';
import { useState } from 'react';
import { calendarKey, type CalendarInfo, type CalendarProvider } from '../../../src/shared/calendar';
import { monthGrid, noonOf } from '../../../src/shared/calendar-layout';
import { type CalendarsResponse, colorOf, providerName, stepAnchor } from './model';

interface Props {
  anchor: string;
  /** The days on screen, marked in the small month. */
  shown: string[];
  today: string;
  firstDay: number;
  calendars: CalendarsResponse | undefined;
  loading: boolean;
  saving: boolean;
  onPickDay: (day: string) => void;
  onToggleCalendar: (calendar: CalendarInfo, visible: boolean) => void;
  onHideDeclined: (hide: boolean) => void;
}

export function CalendarSidebar({ anchor, shown, today, firstDay, calendars, loading, saving, onPickDay, onToggleCalendar, onHideDeclined }: Props) {
  // The small month can be paged without moving the main view. Pinned to the
  // month it was paged from, so moving the main view takes it along again.
  const [paged, setPaged] = useState<{ from: string; month: string } | null>(null);
  const month = paged?.from === anchor.slice(0, 7) ? paged.month : anchor;
  const page = (direction: 1 | -1) => setPaged({ from: anchor.slice(0, 7), month: stepAnchor('month', month, direction) });
  const days = monthGrid(month, firstDay);
  const inView = new Set(shown);
  // One group per connected account: the provider's default account first, then its further accounts by address.
  const groups = (['google', 'microsoft'] as CalendarProvider[])
    .flatMap((provider) => {
      const own = (calendars?.calendars ?? []).filter((c) => c.provider === provider);
      const accounts = [undefined, ...new Set(own.map((c) => c.account).filter((a): a is string => !!a))];
      return accounts.map((account) => ({ provider, account, list: own.filter((c) => c.account === account) }));
    })
    .filter((g) => g.list.length > 0);
  const sharedMicrosoft = (calendars?.calendars ?? []).some((c) => c.provider === 'microsoft' && c.shared);

  return (
    <aside aria-label="Calendars" className="w-full md:w-60 shrink-0 space-y-5 md:overflow-y-auto md:pr-1">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-sm font-semibold text-on-surface">{noonOf(month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
          <div className="flex">
            <button aria-label="Previous month in the small calendar" onClick={() => page(-1)} className="p-1 rounded-full text-on-surface-variant hover:bg-surface-container-high cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
            <button aria-label="Next month in the small calendar" onClick={() => page(1)} className="p-1 rounded-full text-on-surface-variant hover:bg-surface-container-high cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="grid grid-cols-7 text-center">
          {days.slice(0, 7).map((day) => <span key={day} className="text-[10px] text-on-surface-variant py-0.5" aria-hidden>{noonOf(day).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>)}
          {days.map((day) => {
            const outside = day.slice(0, 7) !== month.slice(0, 7);
            const isToday = day === today;
            return (
              <button key={day} onClick={() => onPickDay(day)} aria-current={isToday ? 'date' : undefined}
                aria-label={noonOf(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                className={`h-7 text-xs tabular-nums cursor-pointer ${inView.has(day) ? 'bg-primary-container/50' : 'hover:bg-surface-container-high'} ${inView.has(day) && !inView.has(days[days.indexOf(day) - 1]) ? 'rounded-l-full' : ''} ${inView.has(day) && !inView.has(days[days.indexOf(day) + 1]) ? 'rounded-r-full' : ''} ${!inView.has(day) ? 'rounded-full' : ''}`}>
                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${isToday ? 'bg-primary text-on-primary font-semibold' : outside ? 'text-on-surface-variant/60' : 'text-on-surface'}`}>{noonOf(day).getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        {loading && Array.from({ length: 4 }, (_, i) => <div key={i} className="h-5 rounded-xs bg-surface-container-highest animate-pulse" />)}
        {groups.map(({ provider, account, list }) => (
          <fieldset key={`${provider}:${account ?? ''}`} disabled={saving}>
            <legend className="text-[11px] uppercase tracking-wide text-on-surface-variant mb-1">{providerName(provider)}{account && <span className="normal-case tracking-normal"> · {account}</span>}</legend>
            {list.map((calendar) => (
              <label key={calendarKey(calendar)} className="flex items-center gap-2 py-1 text-sm text-on-surface cursor-pointer" title={calendar.owner ? `Shared by ${calendar.owner}` : undefined}>
                <input type="checkbox" checked={calendar.visible} onChange={(e) => onToggleCalendar(calendar, e.target.checked)} className="w-4 h-4 rounded-xs shrink-0" style={{ accentColor: colorOf(calendar) }} />
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorOf(calendar) }} aria-hidden />
                <span className="truncate flex-1">{calendar.name}</span>
                {calendar.shared && <Users className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-label="Shared with you" />}
                {calendar.readOnly && <Lock className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-label="Read-only" />}
              </label>
            ))}
          </fieldset>
        ))}
        {calendars?.microsoftSharedAccess === false && sharedMicrosoft && (
          <p className="text-xs text-on-surface-variant border border-outline-variant/60 rounded-xs p-2">
            To open Microsoft 365 calendars shared with you, connect Microsoft 365 once more in <a className="text-primary underline" href="/settings?tab=integrations">Settings → Integrations</a>. Your own calendars are not affected.
          </p>
        )}
      </div>

      {groups.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
          <input type="checkbox" disabled={saving} checked={calendars?.preferences.hideDeclined === true} onChange={(e) => onHideDeclined(e.target.checked)} className="w-4 h-4 rounded-xs" />
          Hide events I declined
        </label>
      )}
    </aside>
  );
}
