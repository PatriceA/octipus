'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { useWorkspace, useWorkspaceId } from '@/lib/workspace-context';
import { mailButton, mailInput } from '@/components/mail/mailbox-manager';
import type { CalendarEvent, CalendarProvider } from '../../../src/shared/calendar';

const dateOnly = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localTime = (iso: string) => { const date = new Date(iso); return `${dateOnly(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const allDayLabel = (event: CalendarEvent) => {
  const first = event.start.slice(0, 10);
  if (!event.end) return `All day · ${first}`;
  const last = new Date(`${event.end.slice(0, 10)}T12:00:00`); last.setDate(last.getDate() - 1);
  const until = dateOnly(last);
  return until > first ? `All day · ${first} – ${until}` : `All day · ${first}`;
};
const providerName = (provider: string) => provider === 'google' ? 'Google' : 'Microsoft 365';

export default function CalendarPage() {
  const { activeWorkspace, isLoading } = useWorkspace();
  const workspace = useWorkspaceId();
  if (isLoading) return <p>Loading workspace…</p>;
  if (activeWorkspace?.kind === 'shared' || activeWorkspace?.kind === 'remote') return <p>Switch to your personal workspace to view your connected calendars.</p>;
  return <PersonalCalendar key={workspace ?? 'personal'} />;
}
function PersonalCalendar() {
  const client = useQueryClient();
  const workspace = useWorkspaceId();
  const [from, setFrom] = useState(() => dateOnly(new Date()));
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const [notice, setNotice] = useState('');
  const start = new Date(`${from}T00:00:00`);
  const finish = new Date(start); finish.setDate(finish.getDate() + 7);
  const events = useQuery({ queryKey: ['calendar', workspace, from], enabled: Number.isFinite(+start), queryFn: () => api.get<{ events: CalendarEvent[]; providers: CalendarProvider[]; partial: boolean; truncated?: boolean }>(`/calendar/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(finish.toISOString())}`) });
  const changeWeek = (amount: number) => { const date = new Date(`${from}T12:00:00`); date.setDate(date.getDate() + amount * 7); setFrom(dateOnly(date)); setEditing(null); };
  const rows = (events.data?.events ?? []).filter(event => filter === 'all' || event.provider === filter);
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of rows) { const day = event.allDay ? event.start.slice(0, 10) : dateOnly(new Date(event.start)); groups.set(day, [...(groups.get(day) ?? []), event]); }
  return <div className="space-y-5">
    <PageHeader title="calendar" description="Your connected Google and Microsoft 365 default calendars. Times are shown in your local timezone." />
    <div className="flex flex-wrap gap-3 items-end">
      <button className={mailButton} disabled={!from} onClick={() => changeWeek(-1)}>Previous week</button>
      <label>Week starting<input className={mailInput} type="date" required value={from} onChange={e => { setFrom(e.target.value); setEditing(null); }} /></label>
      <button className={mailButton} disabled={!from} onClick={() => changeWeek(1)}>Next week</button>
      <button className={mailButton} onClick={() => { setFrom(dateOnly(new Date())); setEditing(null); }}>Today</button>
      <label>Calendar provider<select className={mailInput} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All connected calendars</option><option value="google">Google</option><option value="microsoft">Microsoft 365</option></select></label>
      <button className={mailButton} disabled={events.isFetching} onClick={() => events.refetch()}>Refresh calendar</button>
      <button className={mailButton} disabled={!events.data?.providers.length} onClick={() => { setEditing('new'); setNotice(''); }}>New event</button>
    </div>
    <p className="text-sm text-on-surface-variant">Agents can also create and edit events using the Google Workspace or Microsoft 365 calendar tools. Those actions request approval according to your calendar-write permissions.</p>
    {notice && <p role="status">{notice}</p>}
    {events.isLoading && <p>Loading calendar…</p>}
    {events.error && <p role="alert" className="text-error">{events.error.message}</p>}
    {events.data?.partial && <p role="alert" className="text-error">Some calendar data could not be loaded. This schedule may be incomplete.</p>}
    {events.data && !events.data.partial && events.data.providers.length === 0 && <p>No calendar connected. Connect Google or Microsoft 365 in <a className="text-primary underline" href="/settings?tab=integrations">Settings → Integrations</a>.</p>}
    {events.data && events.data.providers.length > 0 && rows.length === 0 && <p>No events in this range.</p>}
    {editing && <EventForm key={editing === 'new' ? 'new' : `${editing.provider}:${editing.id}`} event={editing === 'new' ? undefined : editing} day={from} providers={events.data?.providers ?? []} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); setNotice('Calendar event saved.'); await client.invalidateQueries({ queryKey: ['calendar', workspace] }); }} />}
    {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => <section key={day} className="space-y-2"><h2 className="text-lg font-bold">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      {items.map(event => <article key={`${event.provider}:${event.id}`} className="rounded-md border border-outline-variant p-4 space-y-2"><div className="flex justify-between gap-3"><h3 className="font-bold">{event.title}</h3><button className={mailButton} onClick={() => { setEditing(event); setNotice(''); }}>Edit {event.title}</button></div>
        <p className="text-sm">{event.allDay ? allDayLabel(event) : `${new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${event.end ? ` – ${new Date(event.end).toLocaleString()}` : ''}`} · {providerName(event.provider)}</p>
        {event.location && <p>{event.location}</p>}{event.description && <p className="text-sm whitespace-pre-wrap break-words">{event.description}</p>}
        {event.attendees.length > 0 && <p className="text-xs text-on-surface-variant">Attendees: {event.attendees.map(a => a.name || a.email).join(', ')}</p>}
      </article>)}
    </section>)}
    {events.data?.truncated && <p>This range contains more events than could be loaded. Choose a later start date to see more.</p>}
  </div>;
}
function EventForm({ event, day, providers, onClose, onSaved }: { event?: CalendarEvent; day: string; providers: CalendarProvider[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<CalendarProvider>(event?.provider ?? providers[0] ?? 'google');
  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [start, setStart] = useState(event ? event.allDay ? event.start.slice(0, 10) : localTime(event.start) : `${day}T09:00`);
  const [end, setEnd] = useState(event?.end ? event.allDay ? event.end.slice(0, 10) : localTime(event.end) : `${day}T10:00`);
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changeAllDay = (value: boolean) => {
    const first = start.slice(0, 10);
    const last = end.slice(0, 10);
    const endDay = new Date(`${last}T12:00:00`);
    if (value) {
      // A timed event ending during a day covers that day; midnight does not.
      if (end.slice(11) !== '00:00' || last <= first) endDay.setDate(endDay.getDate() + 1);
      setStart(first); setEnd(dateOnly(endDay));
    } else {
      // An all-day end is exclusive. Preserve the final covered day.
      endDay.setDate(endDay.getDate() - 1);
      setStart(`${first}T09:00`); setEnd(`${dateOnly(endDay)}T10:00`);
    }
    setAllDay(value); setConfirmed(false);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (!confirmed) throw new Error('Confirm this calendar change first.');
      if (Date.parse(end) <= Date.parse(start)) throw new Error('End must be later than start.');
      const body = { provider, confirm: true, title, allDay, start: allDay ? start : new Date(start).toISOString(), end: allDay ? end : new Date(end).toISOString(), location, ...(!event ? { description } : {}) };
      if (event) await api.patch(`/calendar/events/${encodeURIComponent(event.id)}`, body); else await api.post('/calendar/events', body);
      await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the calendar event'); }
    finally { setBusy(false); }
  };
  return <form aria-label={event ? 'Edit calendar event' : 'New calendar event'} onSubmit={save} className="border border-outline-variant rounded-md p-4 space-y-3">
    <fieldset disabled={busy} className="space-y-3"><h2 className="font-bold">{event ? 'Edit event' : 'New event'}</h2>
      {error && <p role="alert" className="text-error">{error}</p>}
      <label className="block">Event provider<select className={mailInput} value={provider} disabled={!!event} onChange={e => { setProvider(e.target.value as CalendarProvider); setConfirmed(false); }}>{providers.map(p => <option key={p} value={p}>{providerName(p)}</option>)}</select></label>
      <label className="block">Title<input className={mailInput} required maxLength={500} value={title} onChange={e => { setTitle(e.target.value); setConfirmed(false); }} /></label>
      <label className="flex gap-2"><input type="checkbox" checked={allDay} onChange={e => changeAllDay(e.target.checked)} />All-day event</label>
      <div className="grid sm:grid-cols-2 gap-3"><label>Start<input className={mailInput} required type={allDay ? 'date' : 'datetime-local'} value={start} onChange={e => { setStart(e.target.value); setConfirmed(false); }} /></label><label>{allDay ? 'End (exclusive)' : 'End'}<input className={mailInput} required type={allDay ? 'date' : 'datetime-local'} value={end} onChange={e => { setEnd(e.target.value); setConfirmed(false); }} /></label></div>
      <label className="block">Location<input className={mailInput} maxLength={2000} value={location} onChange={e => { setLocation(e.target.value); setConfirmed(false); }} /></label>
      {!event && <label className="block">Description<textarea className={mailInput} rows={3} maxLength={20000} value={description} onChange={e => { setDescription(e.target.value); setConfirmed(false); }} /></label>}
      {event && <p className="text-sm">Existing description and attendees are preserved. Editing a recurring occurrence changes that occurrence.</p>}
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Confirm this change in my {providerName(provider)} calendar</label>
      <div className="flex gap-2"><button className={mailButton} type="submit" disabled={!confirmed}>{busy ? 'Saving…' : 'Save event'}</button><button className={mailButton} type="button" onClick={onClose}>Cancel</button></div>
    </fieldset>
  </form>;
}
