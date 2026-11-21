'use client';

import { type FormEvent, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { calendarKey, type CalendarEvent, type CalendarInfo } from '../../../src/shared/calendar';
import { addDays, allDayRange, instantAt } from '../../../src/shared/calendar-layout';
import { buttonPrimary, buttonQuiet, type EventDraft, fieldInput, localInput, type NewEventSeed, providerName } from './model';

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
  const [description, setDescription] = useState('');
  const [guests, setGuests] = useState('');
  const [target, setTarget] = useState(() => {
    if (event) return calendarKey({ provider: event.provider, id: event.calendarId ?? '', account: event.account });
    const first = calendars.find((c) => c.primary && c.visible) ?? calendars.find((c) => c.primary) ?? calendars[0];
    return first ? calendarKey(first) : '';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const calendar = calendars.find((c) => calendarKey(c) === target);
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

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
      const length = Math.max(15, minutes(endTime) - minutes(startTime));
      const end = minutes(time) + length;
      if (end >= 24 * 60) setLastDay(addDays(startDay, 1));
      setEndTime(timeOf(end));
    }
    setStartTime(time);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const provider = event?.provider ?? calendar?.provider;
    if (!provider) { setError('Choose a calendar to save the event in.'); return; }
    let start: string, end: string;
    if (allDay) {
      if (lastDay < startDay) { setError('The last day is before the first.'); return; }
      start = startDay; end = addDays(lastDay, 1);
    } else {
      start = instantAt(startDay, minutes(startTime)); end = instantAt(lastDay, minutes(endTime));
      if (Date.parse(end) <= Date.parse(start)) { setError('The end must be later than the start.'); return; }
    }
    const attendees = guests.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);
    const bad = attendees.find((a) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a));
    if (bad) { setError(`“${bad}” is not an email address.`); return; }
    setBusy(true);
    const saved = await onSave({
      provider, ...((event ? event.account : calendar?.account) ? { account: event ? event.account : calendar?.account } : {}),
      calendarId: event ? event.calendarId : calendar?.id, title: title.trim(), allDay, start, end, location,
      // An edit leaves the description and the guest list as they are.
      ...(!event ? { description, ...(attendees.length ? { attendees } : {}) } : {}),
    });
    if (!saved) setBusy(false);
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={event ? 'Edit event' : 'New event'} maxWidth="lg">
      <form aria-label={event ? 'Edit event' : 'New event'} onSubmit={save}>
        <fieldset disabled={busy} className="space-y-3 text-sm text-on-surface">
          {error && <p role="alert" className="text-error">{error}</p>}
          <label className="block">Title<input autoFocus className={fieldInput} required maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="block">Calendar
            <select className={fieldInput} value={target} disabled={!!event} onChange={(e) => setTarget(e.target.value)}>
              {event && !calendar && <option value={target}>{event.calendarName ?? providerName(event.provider)}</option>}
              {calendars.map((c) => <option key={calendarKey(c)} value={calendarKey(c)}>{c.name} · {c.account ?? providerName(c.provider)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />All day</label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">{allDay ? 'First day' : 'Start date'}<input className={fieldInput} type="date" required value={startDay} onChange={(e) => moveStartDay(e.target.value)} /></label>
            {!allDay && <label className="block">Start time<input className={fieldInput} type="time" required step={300} value={startTime} onChange={(e) => moveStartTime(e.target.value)} /></label>}
            <label className="block">{allDay ? 'Last day' : 'End date'}<input className={fieldInput} type="date" required min={startDay} value={lastDay} onChange={(e) => setLastDay(e.target.value)} /></label>
            {!allDay && <label className="block">End time<input className={fieldInput} type="time" required step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>}
          </div>
          <label className="block">Location<input className={fieldInput} maxLength={2000} value={location} onChange={(e) => setLocation(e.target.value)} /></label>
          {!event && (
            <>
              <label className="block">Guests<input className={fieldInput} placeholder="name@example.com, another@example.com" value={guests} onChange={(e) => setGuests(e.target.value)} />
                <span className="block mt-1 text-xs text-on-surface-variant">Guests get an invitation by email when you save.</span>
              </label>
              <label className="block">Description<textarea className={fieldInput} rows={3} maxLength={20000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
            </>
          )}
          {event && (
            <p className="text-xs text-on-surface-variant">
              The description and the guest list stay as they are.
              {event.recurring && ' This is one occurrence of a repeating event: only this occurrence changes.'}
              {event.attendees.length > 0 && ` You will be asked before the ${event.attendees.length === 1 ? 'guest is' : `${event.attendees.length} guests are`} notified.`}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={buttonQuiet} onClick={onClose}>Cancel</button>
            <button type="submit" className={buttonPrimary}>{busy ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
