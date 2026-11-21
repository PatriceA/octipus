'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ListFilter, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CalendarSidebar } from '@/components/calendar/calendar-sidebar';
import { EventDialog } from '@/components/calendar/event-dialog';
import { EventPopover } from '@/components/calendar/event-popover';
import { AgendaView, MonthView } from '@/components/calendar/list-views';
import {
  buttonPrimary, buttonQuiet, type CalendarsResponse, type CalendarViewName, type EventDraft, eventKey, type EventsResponse, firstWeekday,
  type NewEventSeed, rangeTitle, readerTimeZone, stepAnchor, today as todayOf, viewDays, VIEWS,
} from '@/components/calendar/model';
import { TimeGrid } from '@/components/calendar/time-grid';
import { Modal } from '@/components/ui/modal';
import { PageHeader } from '@/components/ui/page-header';
import { api, ApiError } from '@/lib/api';
import { useWorkspace, useWorkspaceId } from '@/lib/workspace-context';
import { calendarKey, type CalendarEvent, type CalendarInfo, type CalendarResponse, type RecurrenceScope } from '../../../src/shared/calendar';
import { addDays } from '../../../src/shared/calendar-layout';

export default function CalendarPage() {
  const { activeWorkspace, isLoading } = useWorkspace();
  const workspace = useWorkspaceId();
  if (isLoading) return <Frame><p className="text-sm text-on-surface-variant">Loading workspace…</p></Frame>;
  if (activeWorkspace?.kind === 'shared' || activeWorkspace?.kind === 'remote') {
    return <Frame><p className="text-sm text-on-surface-variant">Your connected calendars are personal. Switch to your personal workspace to see them.</p></Frame>;
  }
  return <PersonalCalendar key={workspace ?? 'personal'} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div><PageHeader title="calendar" />{children}</div>;
}

const PHONE = '(max-width: 767px)';
const watchPhone = (notify: () => void) => { const query = window.matchMedia(PHONE); query.addEventListener('change', notify); return () => query.removeEventListener('change', notify); };
const isView = (value: string | null): value is CalendarViewName => VIEWS.some((v) => v.id === value);

interface Notice { text: string; error?: boolean }
/** A change that reaches guests, waiting for the reader to agree. */
interface Ask { what: string; attendees: number; confirm: () => void; cancel: () => void }
/** A change to a repeating event, waiting for the reader to say which events it reaches. */
interface AskScope { what: string; choose: (scope: RecurrenceScope | null) => void }

function PersonalCalendar() {
  const client = useQueryClient();
  const workspace = useWorkspaceId();
  const phone = useSyncExternalStore(watchPhone, () => window.matchMedia(PHONE).matches, () => false);
  const [firstDay] = useState(firstWeekday);
  const [anchor, setAnchor] = useState(todayOf);
  const [view, setViewState] = useState<CalendarViewName>(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('calendar.view'); } catch { /* a convenience only */ }
    // A week does not fit a phone: start there on one day.
    return window.matchMedia(PHONE).matches ? (saved === 'agenda' ? 'agenda' : 'day') : isView(saved) ? saved : 'week';
  });
  const [selected, setSelected] = useState<{ event: CalendarEvent; anchor: DOMRect } | null>(null);
  const [editor, setEditor] = useState<{ event?: CalendarEvent; seed: NewEventSeed } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [askScope, setAskScope] = useState<AskScope | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  const [clockTick, setClockTick] = useState(() => new Date());

  const setView = useCallback((next: CalendarViewName) => {
    setViewState(next); setSelected(null);
    try { localStorage.setItem('calendar.view', next); } catch { /* a convenience only */ }
  }, []);
  const go = useCallback((day: string) => { setAnchor(day); setSelected(null); }, []);
  const openDay = useCallback((day: string) => { setAnchor(day); setView('day'); }, [setView]);

  useEffect(() => { const timer = setInterval(() => setClockTick(new Date()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!notice || notice.error) return; const timer = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(timer); }, [notice]);

  const today = todayOf();
  const nowMin = clockTick.getHours() * 60 + clockTick.getMinutes();
  const days = useMemo(() => viewDays(view, anchor, firstDay), [view, anchor, firstDay]);

  // ── Data ────────────────────────────────────────────────────────────────
  const calendars = useQuery({
    queryKey: ['calendar-list', workspace], staleTime: 60_000,
    // An answer missing a field (an older backend) must not take the page down.
    queryFn: async (): Promise<CalendarsResponse> => {
      const r = await api.get<Partial<CalendarsResponse>>('/calendar/calendars');
      return { calendars: r.calendars ?? [], providers: r.providers ?? [], partial: r.partial === true, preferences: r.preferences ?? {}, microsoftSharedAccess: r.microsoftSharedAccess ?? null };
    },
  });
  const eventsKey = useCallback((shown: string[]) => ['calendar-events', workspace, shown[0], shown.length] as const, [workspace]);
  const fetchEvents = useCallback((shown: string[]) => {
    const from = new Date(`${shown[0]}T00:00:00`);
    const to = new Date(`${addDays(shown[shown.length - 1], 1)}T00:00:00`);
    return api.get<Partial<EventsResponse>>(`/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then((r): EventsResponse => ({ ...r, events: r.events ?? [], providers: r.providers ?? [], partial: r.partial === true }));
  }, []);
  // The range on screen stays while the next one loads.
  const events = useQuery({ queryKey: eventsKey(days), queryFn: () => fetchEvents(days), staleTime: 60_000, placeholderData: keepPreviousData });
  // The ranges either side are fetched ahead, so stepping is instant.
  const loaded = !!events.data && !events.isPlaceholderData;
  useEffect(() => {
    if (!loaded) return;
    for (const direction of [-1, 1] as const) {
      const next = viewDays(view, stepAnchor(view, anchor, direction), firstDay);
      void client.prefetchQuery({ queryKey: eventsKey(next), queryFn: () => fetchEvents(next), staleTime: 60_000 });
    }
  }, [loaded, view, anchor, firstDay, client, eventsKey, fetchEvents]);

  const hideDeclined = calendars.data?.preferences.hideDeclined === true;
  const shownEvents = useMemo(() => (events.data?.events ?? []).filter((e) => !(hideDeclined && e.responseStatus === 'declined')), [events.data, hideDeclined]);
  const writable = useMemo(() => (calendars.data?.calendars ?? []).filter((c) => !c.readOnly), [calendars.data]);
  const connected = calendars.data ? calendars.data.providers.length > 0 || calendars.data.partial : true;
  // The card follows the event as it changes (an answer, a move), and goes when the event does.
  const selectedEvent = selected ? (events.data?.events ?? []).find((e) => eventKey(e) === eventKey(selected.event)) ?? selected.event : null;

  // ── Writes ──────────────────────────────────────────────────────────────
  const patchEvents = useCallback((change: (list: CalendarEvent[]) => CalendarEvent[]) => {
    client.setQueriesData<EventsResponse>({ queryKey: ['calendar-events', workspace] }, (old) => (old ? { ...old, events: change(old.events) } : old));
  }, [client, workspace]);
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ['calendar-events', workspace] }), [client, workspace]);

  /**
   * One change to a calendar. When it would reach guests the server answers
   * with how many, the reader is asked, and the change is sent again with
   * their agreement. Resolves true once it is saved.
   */
  const write = useCallback((options: { what: string; done: string; notify?: boolean; call: (notify: boolean) => Promise<unknown> }) => new Promise<boolean>((resolve) => {
    const attempt = async (notify: boolean) => {
      setBusy(true);
      try {
        await options.call(notify);
        setNotice({ text: options.done });
        void refresh();
        resolve(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.body.requiresAttendeeConfirmation === true) {
          setAsk({
            what: options.what, attendees: Number(err.body.attendees) || 0,
            confirm: () => { setAsk(null); void attempt(true); },
            cancel: () => { setAsk(null); void refresh(); resolve(false); },
          });
          return;
        }
        setNotice({ text: err instanceof Error ? err.message : 'The calendar change failed.', error: true });
        void refresh();
        resolve(false);
      } finally { setBusy(false); }
    };
    void attempt(options.notify === true);
  }), [refresh]);

  const target = (event: CalendarEvent) => ({ provider: event.provider, ...(event.calendarId ? { calendarId: event.calendarId } : {}) });
  const eventPath = (event: CalendarEvent) => `/calendar/events/${encodeURIComponent(event.id)}`;

  const save = (draft: EventDraft, event?: CalendarEvent) => write({
    what: `Save the changes to “${draft.title}”`, done: event ? 'Event saved.' : 'Event created.',
    call: (notify) => event
      ? api.patch(eventPath(event), { ...draft, confirm: true, ...(notify ? { notifyAttendees: true } : {}) })
      : api.post('/calendar/events', { ...draft, confirm: true }),
  });

  /** For a repeating event: which events a change reaches. Resolves null when the reader backs out. */
  const chooseScope = (event: CalendarEvent, what: string) => new Promise<RecurrenceScope | null>((resolve) => {
    if (!event.recurring) { resolve('this'); return; }
    setAskScope({ what, choose: (scope) => { setAskScope(null); resolve(scope); } });
  });

  /**
   * A drag or a resize. Timed events take instants; all-day ones dates
   * (`start` the first day, `end` the day after the last). For a repeating
   * event the reader first says whether it is this one or all of them.
   */
  const move = async (event: CalendarEvent, start: string, end: string, what = 'Move') => {
    const scope = await chooseScope(event, `${what} “${event.title}”`);
    if (!scope) return;
    const key = eventKey(event);
    const shown = event.allDay ? { start: `${start}T00:00:00.000Z`, end: `${end}T00:00:00.000Z` } : { start, end };
    // Every event of the series moves on the provider; the list shows it once it is read again.
    if (scope === 'this') patchEvents((list) => list.map((e) => (eventKey(e) === key ? { ...e, ...shown } : e)));
    setSelected(null);
    void write({
      what: `${what} “${event.title}”${scope === 'all' ? ' (all events)' : ''}`, done: what === 'Resize' ? 'Event changed.' : 'Event moved.',
      call: (notify) => api.patch(eventPath(event), {
        ...target(event), confirm: true, title: event.title, allDay: event.allDay, start, end, timeZone: readerTimeZone(),
        ...(event.recurring ? { scope } : {}), ...(notify ? { notifyAttendees: true } : {}),
      }),
    });
  };

  const remove = (event: CalendarEvent, scope: RecurrenceScope = 'this') => {
    const key = eventKey(event);
    const series = scope === 'all' && event.seriesId;
    setSelected(null);
    // All events of the series go from view at once; the rest follows when the list is read again.
    patchEvents((list) => list.filter((e) => (series ? !(e.provider === event.provider && e.calendarId === event.calendarId && e.seriesId === event.seriesId) : eventKey(e) !== key)));
    // The card already named the guests and the reader pressed delete.
    void write({
      what: `Delete “${event.title}”${scope === 'all' ? ' (all events)' : ''}`, done: scope === 'all' ? 'Series deleted.' : 'Event deleted.', notify: event.attendees.length > 0,
      call: (notify) => api.delete(eventPath(event), { ...target(event), confirm: true, ...(event.recurring ? { scope } : {}), ...(notify ? { notifyAttendees: true } : {}) }),
    });
  };

  const respond = (event: CalendarEvent, response: Exclude<CalendarResponse, 'needsAction'>) => {
    const key = eventKey(event);
    patchEvents((list) => list.map((e) => (eventKey(e) === key ? { ...e, responseStatus: response } : e)));
    void write({ what: 'Answer the invitation', done: response === 'accepted' ? 'Accepted.' : response === 'declined' ? 'Declined.' : 'Answered maybe.', call: () => api.post(`${eventPath(event)}/respond`, { ...target(event), response }) });
  };

  const savePreferences = async (change: { visible?: string[]; hideDeclined?: boolean }) => {
    setSavingPrefs(true);
    // A re-read still in flight carries the choice before this one: drop it, or it would overwrite what is shown.
    await client.cancelQueries({ queryKey: ['calendar-list', workspace] });
    // Shown at once; the server's answer follows.
    client.setQueryData<CalendarsResponse>(['calendar-list', workspace], (old) => old && {
      ...old, preferences: { ...old.preferences, ...change },
      calendars: change.visible ? old.calendars.map((c) => ({ ...c, visible: change.visible!.includes(calendarKey(c)) })) : old.calendars,
    });
    try {
      await api.put('/calendar/preferences', change);
      if (change.visible) await refresh();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Could not save the calendar choice.', error: true });
    } finally {
      await client.invalidateQueries({ queryKey: ['calendar-list', workspace] });
      setSavingPrefs(false);
    }
  };
  const toggleCalendar = (calendar: CalendarInfo, visible: boolean) => {
    const keys = new Set((calendars.data?.calendars ?? []).filter((c) => c.visible).map(calendarKey));
    if (visible) keys.add(calendarKey(calendar)); else keys.delete(calendarKey(calendar));
    void savePreferences({ visible: [...keys] });
  };

  const create = useCallback((seed: NewEventSeed) => { setSelected(null); setEditor({ seed }); }, []);
  const canCreate = writable.length > 0;

  // ── Keyboard ────────────────────────────────────────────────────────────
  const overlayOpen = !!editor || !!ask || !!askScope;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (overlayOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      const pressed = e.key.toLowerCase();
      const next = VIEWS.find((v) => v.key === pressed);
      if (next) setView(next.id);
      else if (pressed === 't') go(todayOf());
      else if (pressed === 'j' || e.key === 'ArrowRight') go(stepAnchor(view, anchor, 1));
      else if (pressed === 'k' || e.key === 'ArrowLeft') go(stepAnchor(view, anchor, -1));
      else if (pressed === 'c' && canCreate) create({ day: days.includes(todayOf()) ? todayOf() : anchor });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [overlayOpen, view, anchor, days, canCreate, setView, go, create]);

  // ── Layout: the grid takes what is left of the window ───────────────────
  const body = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(560);
  useLayoutEffect(() => {
    const fit = () => { if (body.current) setHeight(Math.max(420, window.innerHeight - body.current.getBoundingClientRect().top - 28)); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [notice, events.data?.partial, events.data?.truncated, connected, phone, calendarsOpen]);

  const loading = events.isPending;
  const common = { events: shownEvents, loading, today, selectedKey: selectedEvent ? eventKey(selectedEvent) : undefined, onSelect: (event: CalendarEvent, rect: DOMRect) => setSelected({ event, anchor: rect }), onCreate: canCreate ? create : () => {}, onOpenDay: openDay };
  const failed = events.data?.failedCalendars ?? [];

  return (
    <div className="font-sans">
      <PageHeader
        title="calendar"
        className="mb-3"
        actions={<button className={buttonPrimary} disabled={!canCreate} title={canCreate ? 'New event (c)' : 'Connect a calendar you can write to first'} onClick={() => create({ day: days.includes(today) ? today : anchor })}><Plus className="w-4 h-4" aria-hidden />New event</button>}
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className={buttonQuiet} onClick={() => go(todayOf())} title="Today (t)">Today</button>
        <div className="flex">
          <button aria-label="Previous" title="Previous (k or ←)" onClick={() => go(stepAnchor(view, anchor, -1))} className="p-1.5 rounded-full text-on-surface hover:bg-surface-container-high cursor-pointer"><ChevronLeft className="w-5 h-5" /></button>
          <button aria-label="Next" title="Next (j or →)" onClick={() => go(stepAnchor(view, anchor, 1))} className="p-1.5 rounded-full text-on-surface hover:bg-surface-container-high cursor-pointer"><ChevronRight className="w-5 h-5" /></button>
        </div>
        <h2 className="text-base sm:text-lg font-semibold text-on-surface" aria-live="polite">{rangeTitle(view, anchor, days)}</h2>
        {events.isFetching && !loading && <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" aria-label="Updating" />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="group" aria-label="View" className="inline-flex rounded-full border border-outline-variant/40 p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id} title={`${v.label} (${v.key})`} onClick={() => setView(v.id)}
                className={`px-3 py-1 text-sm rounded-full cursor-pointer ${view === v.id ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:text-on-surface'}`}>{v.label}</button>
            ))}
          </div>
          <button aria-label="Refresh calendar" title="Refresh" disabled={events.isFetching} onClick={() => { void client.invalidateQueries({ queryKey: ['calendar-list', workspace] }); void refresh(); }} className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-high cursor-pointer disabled:opacity-50"><RefreshCw className="w-4 h-4" /></button>
          <button aria-expanded={calendarsOpen} onClick={() => setCalendarsOpen(!calendarsOpen)} className={`${buttonQuiet} md:hidden`}><ListFilter className="w-4 h-4" aria-hidden />Calendars</button>
        </div>
      </div>

      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className={`mb-3 rounded-xs border px-3 py-2 text-sm ${notice.error ? 'border-error/30 bg-error/10 text-error' : 'border-primary/20 bg-primary/10 text-primary'}`}>
          {notice.text}<button onClick={() => setNotice(null)} className="ml-2 underline cursor-pointer">dismiss</button>
        </p>
      )}
      {(events.error || calendars.error) && <p role="alert" className="mb-3 rounded-xs border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{(events.error ?? calendars.error)?.message}</p>}
      {(events.data?.partial || calendars.data?.partial) && (
        <p role="alert" className="mb-3 rounded-xs border border-warning/30 bg-warning-container px-3 py-2 text-sm text-on-warning-container">
          {failed.length > 0 ? `Could not load ${failed.join(', ')}.` : 'Some calendar data could not be loaded.'} This schedule may be incomplete.
          {calendars.data?.microsoftSharedAccess === false && failed.length > 0 && <> A Microsoft 365 calendar shared with you opens after you connect Microsoft 365 once more in <a className="underline" href="/settings?tab=integrations">Settings → Integrations</a>.</>}
        </p>
      )}
      {events.data?.truncated && <p role="status" className="mb-3 rounded-xs border border-outline-variant/60 px-3 py-2 text-sm text-on-surface-variant">This range holds more events than could be loaded. Choose a shorter view to see them all.</p>}

      <div ref={body} className="flex flex-col md:flex-row gap-4" style={phone ? undefined : { height }}>
        <div className={`${calendarsOpen ? 'block' : 'hidden'} md:block md:h-full`}>
          <CalendarSidebar anchor={anchor} shown={view === 'month' ? [] : days} today={today} firstDay={firstDay} calendars={calendars.data} loading={calendars.isPending} saving={savingPrefs}
            onPickDay={go} onToggleCalendar={toggleCalendar} onHideDeclined={(hide) => void savePreferences({ hideDeclined: hide })} />
        </div>
        <div className="min-w-0 md:flex-1 md:h-full" style={phone ? { height: Math.max(420, height) } : undefined}>
          {!connected ? (
            <div className="h-full rounded-md border border-dashed border-outline-variant flex flex-col items-center justify-center text-center px-6 text-on-surface-variant">
              <p className="text-on-surface font-medium">No calendar connected</p>
              <p className="text-sm mt-1">Connect Google or Microsoft 365 in <a className="text-primary underline" href="/settings?tab=integrations">Settings → Integrations</a>.</p>
            </div>
          ) : view === 'month' ? <MonthView days={days} month={anchor} onMove={(event, start, end) => void move(event, start, end)} {...common} />
            : view === 'agenda' ? <AgendaView days={days} {...common} />
            : <TimeGrid key={view} days={days} nowMin={nowMin} onMove={(event, start, end, kind) => void move(event, start, end, kind === 'resize' ? 'Resize' : 'Move')} {...common} />}
        </div>
      </div>

      {selected && selectedEvent && (
        <EventPopover key={eventKey(selectedEvent)} event={selectedEvent} anchor={selected.anchor} busy={busy} onClose={() => setSelected(null)}
          onEdit={() => { setEditor({ event: selectedEvent, seed: { day: anchor } }); setSelected(null); }}
          onDelete={(scope) => remove(selectedEvent, scope)} onRespond={(response) => respond(selectedEvent, response)} />
      )}
      {editor && (
        <EventDialog key={editor.event ? eventKey(editor.event) : `new-${editor.seed.day}-${editor.seed.startMin ?? ''}`} event={editor.event} seed={editor.seed} calendars={writable}
          onClose={() => setEditor(null)}
          onSave={async (draft) => { const saved = await save(draft, editor.event); if (saved) setEditor(null); return saved; }} />
      )}
      {askScope && (
        <Modal open onClose={() => askScope.choose(null)} title="This is a repeating event" maxWidth="sm">
          <div role="alertdialog" aria-label="Which events" className="space-y-3 text-sm text-on-surface">
            <p>{askScope.what}: only this event, or every event of the series?</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className={buttonQuiet} onClick={() => askScope.choose(null)}>Cancel</button>
              <button className={buttonQuiet} onClick={() => askScope.choose('all')}>All events</button>
              <button className={buttonPrimary} onClick={() => askScope.choose('this')}>This event</button>
            </div>
          </div>
        </Modal>
      )}
      {ask && (
        <Modal open onClose={ask.cancel} title="Guests will be notified" maxWidth="sm">
          <div role="alertdialog" aria-label="Guests will be notified" className="space-y-3 text-sm text-on-surface">
            <p>{ask.what}? {ask.attendees === 1 ? 'This event has 1 guest, who gets' : `This event has ${ask.attendees} guests, who get`} an email about the change.</p>
            <div className="flex justify-end gap-2">
              <button className={buttonQuiet} onClick={ask.cancel}>Cancel</button>
              <button className={buttonPrimary} onClick={ask.confirm}>{ask.attendees === 1 ? 'Notify the guest' : `Notify ${ask.attendees} guests`}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
