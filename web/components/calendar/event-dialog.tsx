'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import {
  type BusyInterval, calendarKey, type CalendarEvent, type CalendarEventDetails, type CalendarInfo, type CalendarProvider, type CalendarRecurrence,
  type FreeBusyResponse, REMINDER_CHOICES, type RecurrenceFrequency, type RecurrenceScope, type Weekday, WEEKDAYS,
} from '../../../src/shared/calendar';
import { findFreeSlots, nextDays } from '../../../src/shared/calendar-free';
import { addDays, allDayRange, instantAt, noonOf } from '../../../src/shared/calendar-layout';
import { buttonPrimary, buttonQuiet, clock, type EventDraft, fieldInput, localInput, type NewEventSeed, providerName, readerTimeZone, recurrenceLabel, reminderLabel } from './model';

interface Props {
  /** The event being changed; absent for a new one. */
  event?: CalendarEvent;
  /** Where on the grid a new event was started. */
  seed: NewEventSeed;
  /** Calendars the reader may write to. */
  calendars: CalendarInfo[];
  onClose: () => void;
  /** Resolves true once saved; false leaves the dialog open with what was typed. */
  onSave: (draft: EventDraft) => Promise<boolean>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const timeOf = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** A field inside a line of text ("every [2] weeks"): as wide as its content. */
const inlineField = 'rounded-xs border border-outline-variant/60 bg-surface px-2 py-1 text-sm text-on-surface';
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const sameRule = (a?: CalendarRecurrence | 'custom', b?: CalendarRecurrence | 'custom') => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const weekdayOf = (day: string): Weekday => WEEKDAYS[noonOf(day).getDay()];

/** What the Repeat and Reminder selects hold: '' is "keep the calendar's default". */
type ReminderChoice = '' | 'none' | string;

export function EventDialog({ event, seed, calendars, onClose, onSave }: Props) {
  const startMin = seed.startMin ?? 9 * 60;
  const endMin = seed.endMin ?? startMin + 60;
  const initialAllDay = event ? event.allDay : seed.allDay === true;
  // An all-day event's stored end is the day after; people think of the last day.
  const range = event?.allDay ? allDayRange(event) : null;
  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(initialAllDay);
  const [startDay, setStartDay] = useState(range?.first ?? (event ? localInput(event.start).slice(0, 10) : seed.day));
  const [lastDay, setLastDay] = useState(range ? addDays(range.end, -1) : event ? localInput(event.end ?? event.start).slice(0, 10) : endMin >= 24 * 60 ? addDays(seed.day, 1) : seed.day);
  const [startTime, setStartTime] = useState(event && !event.allDay ? localInput(event.start).slice(11) : timeOf(startMin));
  const [endTime, setEndTime] = useState(event && !event.allDay && event.end ? localInput(event.end).slice(11) : timeOf(endMin));
  const [location, setLocation] = useState(event?.location ?? '');
  const [target, setTarget] = useState(() => {
    if (event) return `${event.provider}:${event.calendarId ?? ''}`;
    const first = calendars.find((c) => c.primary && c.visible) ?? calendars.find((c) => c.primary) ?? calendars[0];
    return first ? calendarKey(first) : '';
  });
  const [scope, setScope] = useState<RecurrenceScope>('this');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // An edit reads what the list shortens or leaves out: the whole description, the guests, the reminder, the series' rule.
  const details = useQuery({
    queryKey: ['calendar-event-details', event?.provider, event?.calendarId, event?.id],
    enabled: !!event,
    staleTime: 0,
    queryFn: () => api.get<CalendarEventDetails>(`/calendar/events/${encodeURIComponent(event!.id)}/details?provider=${event!.provider}${event!.calendarId ? `&calendarId=${encodeURIComponent(event!.calendarId)}` : ''}`),
  });
  const known = details.data;
  // Until the details are in, the fields they fill hold no value of their own: `undefined` means "as read".
  const [descriptionEdit, setDescriptionEdit] = useState<string | undefined>(event ? undefined : '');
  const [guestsEdit, setGuestsEdit] = useState<string[] | undefined>(event ? undefined : []);
  const [reminderEdit, setReminderEdit] = useState<ReminderChoice | undefined>(event ? undefined : '');
  const [ruleEdit, setRuleEdit] = useState<CalendarRecurrence | null | undefined>(event ? undefined : null);
  const knownReminder: ReminderChoice = known?.reminderMinutes === undefined ? '' : known.reminderMinutes === null ? 'none' : String(known.reminderMinutes);
  const description = descriptionEdit ?? known?.description ?? '';
  const listed = guestsEdit ?? (known?.attendees ?? []).map((a) => a.email!).filter(Boolean);
  // Addresses still being typed count too: nobody is dropped for want of an Enter.
  const [typing, setTyping] = useState('');
  const pending = typing.split(/[\s,;]+/).map((a) => a.trim()).filter((a) => a && !listed.some((g) => g.toLowerCase() === a.toLowerCase()));
  const guests = [...listed, ...pending];
  const reminder = reminderEdit ?? knownReminder;
  const knownRule = known?.recurrence;
  const rule = ruleEdit !== undefined ? ruleEdit : knownRule && knownRule !== 'custom' ? knownRule : null;
  const loadingDetails = !!event && details.isPending;

  const calendar = calendars.find((c) => calendarKey(c) === target);
  const provider: CalendarProvider | undefined = event?.provider ?? calendar?.provider;
  const series = !!event?.recurring;
  // The repeat rule is set on a new event, or on the whole series.
  const canRepeat = !event || (series && scope === 'all' && knownRule !== 'custom');
  const durationMin = allDay ? 0 : Math.max(15, (Date.parse(instantAt(lastDay, minutesOf(endTime))) - Date.parse(instantAt(startDay, minutesOf(startTime)))) / 60_000);

  // Keep the end after the start when the start moves: the length stays.
  const moveStartDay = (day: string) => {
    if (day && startDay && lastDay) {
      const length = Math.round((Date.parse(`${lastDay}T12:00:00`) - Date.parse(`${startDay}T12:00:00`)) / 86_400_000);
      setLastDay(addDays(day, Math.max(0, length)));
    }
    setStartDay(day);
  };
  const moveStartTime = (time: string) => {
    if (time && startTime && endTime && lastDay === startDay) {
      const length = Math.max(15, minutesOf(endTime) - minutesOf(startTime));
      const end = minutesOf(time) + length;
      if (end >= 24 * 60) setLastDay(addDays(startDay, 1));
      setEndTime(timeOf(end));
    }
    setStartTime(time);
  };
  const pickSlot = (start: string, end: string) => {
    const s = localInput(start), e = localInput(end);
    setStartDay(s.slice(0, 10)); setStartTime(s.slice(11)); setLastDay(e.slice(0, 10)); setEndTime(e.slice(11));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!provider) { setError('Choose a calendar to save the event in.'); return; }
    if (loadingDetails) { setError('Still reading the event. Try again in a moment.'); return; }
    let start: string, end: string;
    if (allDay) {
      if (lastDay < startDay) { setError('The last day is before the first.'); return; }
      start = startDay; end = addDays(lastDay, 1);
    } else {
      start = instantAt(startDay, minutesOf(startTime)); end = instantAt(lastDay, minutesOf(endTime));
      if (Date.parse(end) <= Date.parse(start)) { setError('The end must be later than the start.'); return; }
    }
    const bad = guests.find((a) => !ADDRESS.test(a));
    if (bad) { setError(`“${bad}” is not an email address.`); return; }
    if (rule?.frequency === 'weekly' && rule.byDay && !rule.byDay.length) { setError('Choose at least one day of the week.'); return; }
    if (rule?.until && rule.until < startDay) { setError('The repeat ends before the event starts.'); return; }
    const reminderValue = reminder === 'none' ? null : reminder === '' ? undefined : Number(reminder);
    const draft: EventDraft = {
      provider, calendarId: event ? event.calendarId : calendar?.id, title: title.trim(), allDay, start, end, location, timeZone: readerTimeZone(),
    };
    if (!event) {
      // A new event: everything that was filled in.
      if (description) draft.description = description;
      if (guests.length) draft.attendees = guests;
      if (reminderValue !== undefined) draft.reminderMinutes = reminderValue;
      if (rule) draft.recurrence = rule;
    } else {
      // An edit sends only what changed, so nothing the reader did not touch is rewritten.
      if (series) draft.scope = scope;
      if (description !== (known?.description ?? '')) draft.description = description;
      const before = (known?.attendees ?? []).map((a) => a.email!.toLowerCase()).sort().join(',');
      if (guests.map((g) => g.toLowerCase()).sort().join(',') !== before) draft.attendees = guests;
      if (reminder !== knownReminder && reminderValue !== undefined) draft.reminderMinutes = reminderValue;
      if (canRepeat && rule && !sameRule(rule, knownRule)) draft.recurrence = rule;
    }
    setBusy(true);
    const saved = await onSave(draft);
    if (!saved) setBusy(false);
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={event ? 'Edit event' : 'New event'} maxWidth="lg">
      <form aria-label={event ? 'Edit event' : 'New event'} onSubmit={save} className="max-h-[78vh] overflow-y-auto -m-4 p-4">
        <fieldset disabled={busy} className="space-y-3 text-sm text-on-surface">
          {error && <p role="alert" className="text-error">{error}</p>}
          {details.error && <p role="alert" className="text-error">Could not read the event: {(details.error as Error).message}. Description and guests stay as they are.</p>}
          <label className="block">Title<input autoFocus className={fieldInput} required maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="block">Calendar
            <select aria-label="Calendar" className={fieldInput} value={target} disabled={!!event} onChange={(e) => setTarget(e.target.value)}>
              {event && !calendar && <option value={target}>{event.calendarName ?? providerName(event.provider)}</option>}
              {calendars.map((c) => <option key={calendarKey(c)} value={calendarKey(c)}>{c.name} · {providerName(c.provider)}</option>)}
            </select>
          </label>

          {series && (
            <fieldset className="rounded-xs border border-outline-variant/40 px-3 py-2">
              <legend className="px-1 text-xs text-on-surface-variant">This event repeats. Change</legend>
              <div role="radiogroup" aria-label="Change which events" className="flex flex-wrap gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="scope" checked={scope === 'this'} onChange={() => setScope('this')} />This event</label>
                <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />All events</label>
              </div>
              {scope === 'all' && <p className="mt-1 text-xs text-on-surface-variant">The time moves for every event by as much as you move it here. Moving all of them to another day: change the repeat days instead.</p>}
            </fieldset>
          )}

          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />All day</label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">{allDay ? 'First day' : 'Start date'}<input className={fieldInput} type="date" required value={startDay} onChange={(e) => moveStartDay(e.target.value)} /></label>
            {!allDay && <label className="block">Start time<input className={fieldInput} type="time" required step={300} value={startTime} onChange={(e) => moveStartTime(e.target.value)} /></label>}
            <label className="block">{allDay ? 'Last day' : 'End date'}<input className={fieldInput} type="date" required min={startDay} value={lastDay} onChange={(e) => setLastDay(e.target.value)} /></label>
            {!allDay && <label className="block">End time<input className={fieldInput} type="time" required step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>}
          </div>

          {canRepeat ? (
            <RepeatEditor rule={rule} startDay={startDay} onChange={setRuleEdit} disabled={loadingDetails} />
          ) : series && (
            <p className="text-xs text-on-surface-variant">
              {knownRule === 'custom' ? 'Repeats by a rule this page cannot change; it stays as it is.' : knownRule ? `${recurrenceLabel(knownRule)}. To change the repeat, choose “All events”.` : 'Repeats.'}
            </p>
          )}

          <label className="block">Reminder
            <select aria-label="Reminder" className={fieldInput} value={reminder} disabled={loadingDetails} onChange={(e) => setReminderEdit(e.target.value)}>
              <option value="">The calendar&apos;s default</option>
              <option value="none">No reminder</option>
              {[...new Set([...REMINDER_CHOICES, ...(reminder && reminder !== 'none' ? [Number(reminder)] : [])])].sort((a, b) => a - b).map((m) => <option key={m} value={String(m)}>{reminderLabel(m)}</option>)}
            </select>
          </label>

          <label className="block">Location<input className={fieldInput} maxLength={2000} value={location} onChange={(e) => setLocation(e.target.value)} /></label>

          <GuestEditor guests={listed} typing={typing} onTyping={setTyping} answers={known?.attendees} disabled={loadingDetails} onChange={setGuestsEdit} isNew={!event} />
          {guests.some((g) => ADDRESS.test(g)) && !allDay && provider && (
            <Availability provider={provider} guests={guests.filter((g) => ADDRESS.test(g))} day={startDay} durationMin={durationMin}
              chosen={{ start: instantAt(startDay, minutesOf(startTime)), end: instantAt(lastDay, minutesOf(endTime)) }} onPick={pickSlot} />
          )}

          <label className="block">Description
            {loadingDetails
              ? <span className={`${fieldInput} flex items-center gap-2 text-on-surface-variant`}><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />Reading the description…</span>
              : <textarea className={fieldInput} rows={4} maxLength={20000} value={description} onChange={(e) => setDescriptionEdit(e.target.value)} />}
            {known?.descriptionHasFormatting && <span className="block mt-1 text-xs text-on-surface-variant">This description has formatting. It stays as it is unless you change the text; a changed description is saved as plain text.</span>}
          </label>

          {event && event.attendees.length > 0 && (
            <p className="text-xs text-on-surface-variant">You will be asked before the {event.attendees.length === 1 ? 'guest is' : `${event.attendees.length} guests are`} notified.</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={buttonQuiet} onClick={onClose}>Cancel</button>
            <button type="submit" className={buttonPrimary} disabled={loadingDetails}>{busy ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

const FREQUENCY_LABEL: Record<RecurrenceFrequency, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
const UNIT: Record<RecurrenceFrequency, string> = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };

/** Repeat: none, daily, weekly on chosen days, monthly, yearly; every n; ending never, on a date or after n times. */
function RepeatEditor({ rule, startDay, disabled, onChange }: { rule: CalendarRecurrence | null; startDay: string; disabled: boolean; onChange: (rule: CalendarRecurrence | null) => void }) {
  const ends = rule?.until ? 'date' : rule?.count ? 'count' : 'never';
  const set = (patch: Partial<CalendarRecurrence>) => rule && onChange(Object.fromEntries(Object.entries({ ...rule, ...patch }).filter(([, v]) => v !== undefined)) as unknown as CalendarRecurrence);
  return (
    <div className="space-y-2">
      <label className="block">Repeat
        <select aria-label="Repeat" className={fieldInput} disabled={disabled} value={rule?.frequency ?? ''} onChange={(e) => {
          const frequency = e.target.value as RecurrenceFrequency | '';
          if (!frequency) { onChange(null); return; }
          onChange({ frequency, ...(frequency === 'weekly' ? { byDay: [weekdayOf(startDay)] } : {}), ...(rule?.until ? { until: rule.until } : {}), ...(rule?.count ? { count: rule.count } : {}) });
        }}>
          <option value="">Does not repeat</option>
          {(Object.keys(FREQUENCY_LABEL) as RecurrenceFrequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
        </select>
      </label>
      {rule && (
        <div className="space-y-2 rounded-xs border border-outline-variant/40 p-2.5">
          <label className="flex items-center gap-2">Every
            <input aria-label="Repeat every" type="number" min={1} max={99} className={`${inlineField} w-16`} value={rule.interval ?? 1} onChange={(e) => set({ interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })} />
            {UNIT[rule.frequency]}
          </label>
          {rule.frequency === 'weekly' && (
            <div role="group" aria-label="Repeat on" className="flex flex-wrap gap-1">
              {WEEKDAYS.map((d, i) => {
                const on = rule.byDay?.includes(d) ?? false;
                const name = new Date(2026, 10, 15 + i).toLocaleDateString(undefined, { weekday: 'short' });
                return (
                  <button key={d} type="button" aria-pressed={on} aria-label={new Date(2026, 10, 15 + i).toLocaleDateString(undefined, { weekday: 'long' })}
                    onClick={() => set({ byDay: on ? (rule.byDay ?? []).filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || rule.byDay?.includes(x)) })}
                    className={`min-w-10 px-2 py-1 text-xs rounded-full border cursor-pointer ${on ? 'border-primary bg-primary-container text-on-primary-container font-semibold' : 'border-outline-variant/60 text-on-surface-variant hover:bg-surface-container-high'}`}>{name}</button>
                );
              })}
            </div>
          )}
          <div role="radiogroup" aria-label="Ends" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-on-surface-variant">Ends</span>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="ends" checked={ends === 'never'} onChange={() => set({ until: undefined, count: undefined })} />Never</label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="ends" checked={ends === 'date'} onChange={() => set({ count: undefined, until: rule.until ?? addDays(startDay, 90) })} />On
              {ends === 'date' && <input aria-label="Last day of the repeat" type="date" min={startDay} className={inlineField} value={rule.until} onChange={(e) => set({ until: e.target.value || undefined })} />}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="ends" checked={ends === 'count'} onChange={() => set({ until: undefined, count: rule.count ?? 10 })} />After
              {ends === 'count' && <><input aria-label="Number of times" type="number" min={1} max={730} className={`${inlineField} w-16`} value={rule.count} onChange={(e) => set({ count: Math.max(1, Math.min(730, Number(e.target.value) || 1)) })} />times</>}
            </label>
          </div>
          <p className="text-xs text-on-surface-variant">{recurrenceLabel(rule)}</p>
        </div>
      )}
    </div>
  );
}

/** Guests as removable chips, with a field to add more. */
function GuestEditor({ guests, typing: draft, onTyping: setDraft, answers, disabled, isNew, onChange }: {
  guests: string[]; typing: string; onTyping: (text: string) => void; answers?: CalendarEventDetails['attendees']; disabled: boolean; isNew: boolean; onChange: (guests: string[]) => void;
}) {
  const add = () => {
    const more = draft.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);
    if (!more.length) return;
    const known = new Set(guests.map((g) => g.toLowerCase()));
    onChange([...guests, ...more.filter((a) => !known.has(a.toLowerCase()))]);
    setDraft('');
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { if (draft.trim()) { e.preventDefault(); add(); } }
    else if (e.key === 'Backspace' && !draft && guests.length) onChange(guests.slice(0, -1));
  };
  const answerOf = (email: string) => answers?.find((a) => a.email?.toLowerCase() === email.toLowerCase())?.response;
  return (
    <div>
      <label htmlFor="event-guests">Guests</label>
      <div className={`${fieldInput} flex flex-wrap items-center gap-1.5`}>
        {guests.map((g) => {
          const answer = answerOf(g);
          return (
            <span key={g} className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2 py-0.5 text-xs">
              <span>{g}</span>
              {answer && answer !== 'needsAction' && <span className="text-on-surface-variant">· {answer === 'accepted' ? 'yes' : answer === 'declined' ? 'no' : 'maybe'}</span>}
              <button type="button" disabled={disabled} aria-label={`Remove ${g}`} onClick={() => onChange(guests.filter((x) => x !== g))} className="text-on-surface-variant hover:text-error cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          );
        })}
        <input id="event-guests" disabled={disabled} className="flex-1 min-w-40 bg-transparent outline-none py-0.5" placeholder={disabled ? 'Reading the guest list…' : guests.length ? 'Add another' : 'name@example.com'}
          value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} />
      </div>
      <span className="block mt-1 text-xs text-on-surface-variant">{isNew ? 'Guests get an invitation by email when you save.' : 'New guests get an invitation; removed guests are told they are no longer invited.'}</span>
    </div>
  );
}

const STRIP_START = 7 * 60;
const STRIP_END = 20 * 60;

/** The guests' busy time on the chosen day, and the next free slots for everyone. */
function Availability({ provider, guests, day, durationMin, chosen, onPick }: { provider: CalendarProvider; guests: string[]; day: string; durationMin: number; chosen: { start: string; end: string }; onPick: (start: string, end: string) => void }) {
  // When "Find a time" was pressed: no slot before then.
  const [asked, setAsked] = useState<number | null>(null);
  const valid = guests.filter((g) => ADDRESS.test(g)).slice(0, 20);
  const from = instantAt(day, 0);
  const to = instantAt(addDays(day, 7), 0);
  const query = useQuery({
    queryKey: ['calendar-freebusy', provider, valid.join(','), from],
    enabled: valid.length > 0,
    staleTime: 60_000,
    queryFn: () => api.post<FreeBusyResponse>('/calendar/freebusy', { provider, attendees: valid, from, to }),
  });
  const data = query.data;
  const everyone: BusyInterval[] = useMemo(() => (data ? [...data.own, ...Object.values(data.busy).flat()] : []), [data]);
  const unknown = data ? Object.keys(data.failed) : [];
  const slots = useMemo(() => (data && asked ? findFreeSlots(everyone, { days: nextDays(day, 7), durationMin, notBefore: asked }) : []), [data, asked, everyone, day, durationMin]);
  const dayStart = Date.parse(instantAt(day, 0));
  const pct = (iso: string) => Math.max(0, Math.min(100, (((Date.parse(iso) - dayStart) / 60_000 - STRIP_START) / (STRIP_END - STRIP_START)) * 100));
  const rows: Array<{ name: string; busy?: BusyInterval[]; failed?: string }> = data
    ? [{ name: 'You', busy: data.own }, ...valid.map((g) => ({ name: g, busy: data.busy[g], failed: data.failed[g] }))]
    : [];

  return (
    <section aria-label="Availability" className="rounded-xs border border-outline-variant/40 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-on-surface">Availability · {noonOf(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        {query.isFetching && <Loader2 className="w-3.5 h-3.5 animate-spin text-on-surface-variant" aria-label="Reading schedules" />}
      </div>
      {query.error && <p role="alert" className="text-xs text-error">Could not read the schedules: {(query.error as Error).message}. Their time is unknown, not free.</p>}
      {data && (
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.name} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-xs text-on-surface-variant" title={row.name}>{row.name}</span>
              {row.failed ? (
                <span className="flex-1 text-xs text-warning" data-testid="schedule-unknown">Schedule unknown: {row.failed}</span>
              ) : (
                <div className="relative flex-1 h-4 rounded-xs bg-surface-container-high" data-testid={`busy-${row.name}`}>
                  {(row.busy ?? []).filter((b) => Date.parse(b.end) > dayStart && Date.parse(b.start) < dayStart + 86_400_000).map((b, i) => (
                    <span key={i} title={`Busy ${clock(new Date(b.start))} – ${clock(new Date(b.end))}`} data-busy className="absolute inset-y-0 rounded-xs bg-error/50" style={{ left: `${pct(b.start)}%`, width: `${Math.max(1, pct(b.end) - pct(b.start))}%` }} />
                  ))}
                  <span className="absolute inset-y-[-2px] rounded-xs border-2 border-primary pointer-events-none" style={{ left: `${pct(chosen.start)}%`, width: `${Math.max(1, pct(chosen.end) - pct(chosen.start))}%` }} aria-hidden />
                </div>
              )}
            </div>
          ))}
          <div className="flex gap-2 text-[10px] text-on-surface-variant" aria-hidden>
            <span className="w-32 shrink-0" />
            <div className="relative flex-1 h-3">
              {[9, 12, 15, 18].map((hour) => (
                <span key={hour} className="absolute -translate-x-1/2" style={{ left: `${((hour * 60 - STRIP_START) / (STRIP_END - STRIP_START)) * 100}%` }}>{clock(new Date(2000, 0, 1, hour))}</span>
              ))}
            </div>
          </div>
          {data.ownPartial && <p className="text-xs text-on-surface-variant">Some of your calendars could not be read: your own free time may be less than shown.</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonQuiet} disabled={!data || durationMin <= 0} onClick={() => setAsked(Date.now())}><Search className="w-3.5 h-3.5" aria-hidden />Find a time</button>
        {asked && data && slots.length === 0 && <span className="text-xs text-on-surface-variant">No free {durationMin}-minute slot for everyone in working hours (9–17) this week.</span>}
        {asked && slots.map((slot) => (
          <button key={slot.start} type="button" onClick={() => onPick(slot.start, slot.end)} className="px-2.5 py-1 text-xs rounded-full border border-primary/40 text-on-surface hover:bg-primary-container/40 cursor-pointer">
            {new Date(slot.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, {clock(new Date(slot.start))}
          </button>
        ))}
      </div>
      {asked && unknown.length > 0 && <p className="text-xs text-warning">Not counted: {unknown.join(', ')} (schedule unknown).</p>}
    </section>
  );
}
