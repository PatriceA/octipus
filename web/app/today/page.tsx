'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, CalendarDays, ChevronRight, CircleCheck, CornerDownLeft, Loader2, MapPin, Maximize2, NotebookPen, Plus, RefreshCw, Sun, Video } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blockedText, subtaskProgress } from '@/components/tasks/task-board';
import { calendarEventsKey, colorOf, eventKey, fetchCalendarEvents, timeLabel } from '@/components/calendar/model';
import { CaptureBar } from '@/components/todos/capture-bar';
import { browserTimezone, localToday, type Todo } from '@/components/todos/model';
import { MyDaySuggestions } from '@/components/todos/my-day-suggestions';
import { openQuickAddTodo } from '@/components/todos/quick-add-dialog';
import { TodoDetail } from '@/components/todos/todo-detail';
import { type RowContext, TodoRow } from '@/components/todos/todo-row';
import { type NewTodo, type TodosApi, useTodos } from '@/components/todos/use-todos';
import { api, ApiError } from '@/lib/api';
import { usePageOn } from '@/lib/modules';
import { cn } from '@/lib/utils';
import { useWorkspace, useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import { NoteEditor, type EditorMode } from '../notes/note-editor';
import { DraftNoticeBar } from '../notes/draft-notice';
import type { NoteDetail, NoteIndexEntry, TagCount } from '../notes/types';
import { useNoteDraft } from '../notes/use-note-draft';
import { useNoteTodos } from '../notes/use-note-todos';
import type { CalendarEvent } from '../../../src/shared/calendar';
import { todayParts } from '../../../src/core/tasks/smart-lists';
import { toLookup } from '../../../src/core/tasks/structure';

/** A to-do made from today's note is one for today. */
const TODAY_TODO = { myDay: true };

/** A completed row shows its tick for a beat before it moves to "Done today". */
const COMPLETE_MS = 420;

/**
 * Today: the day on one page. The to-dos that are overdue, due today or in
 * My Day (with capture, and yesterday's unfinished picks offered again),
 * today's calendar, and today's daily note written in place (it is made by
 * the first keystroke, never by opening the page). The to-do components,
 * the note editor and its draft engine, and the calendar's data are the
 * ones the To-dos, Notes and Calendar pages use.
 */
export default function TodayPage() {
  const { activeWorkspace } = useWorkspace();
  if (activeWorkspace?.kind === 'remote') {
    return (
      <div className="today-page"><div className="today-inner">
        <p className="text-sm text-on-surface-variant">Today shows this install’s to-dos and notes. Open the space’s to-dos and notes from the sidebar.</p>
      </div></div>
    );
  }
  return (
    <Suspense fallback={null}>
      {/* A workspace switch starts afresh: no draft or cache crosses it. */}
      <Today key={activeWorkspace?.id ?? 'none'} />
    </Suspense>
  );
}

/** The minute, so "today" and the event list move on while the page stays open. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Today() {
  const router = useRouter();
  const params = useSearchParams();
  const pageOn = usePageOn();
  const { activeWorkspace } = useWorkspace();
  const isSpace = activeWorkspace?.kind === 'shared';
  const { canWrite, canComment } = useWorkspaceAccess();
  const todos = useTodos();
  const now = useMinute();
  const day = localToday(now);
  const selectedId = params.get('task');
  const open = useCallback((id: string | null) => router.replace(id ? `/today?task=${encodeURIComponent(id)}` : '/today'), [router]);

  return (
    <div className="today-page">
      <div className="today-scroll">
        <div className="today-inner">
          {/* A div, not <header>: the app shell pads every header on phones for its own menu button. */}
          <div className="today-head">
            <div className="min-w-0 flex-1">
              <h1><Sun className="h-6 w-6 shrink-0 text-primary" aria-hidden />Today</h1>
              <p>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            </div>
            {canWrite && pageOn('/tasks') && (
              <button type="button" className="todo-tool" onClick={() => openQuickAddTodo()} title="Add a to-do from anywhere (Q)">
                <Plus className="h-4 w-4" /><span className="todo-tool-label">Quick add</span><kbd className="notes-kbd today-kbd">Q</kbd>
              </button>
            )}
          </div>
          <div className="today-grid">
            <div className="today-col">
              {pageOn('/tasks') && <TodayTodos todos={todos} now={now} day={day} canWrite={canWrite} isSpace={isSpace} selectedId={selectedId} onOpen={open} />}
              {pageOn('/calendar') && <TodayEvents day={day} now={now} personal={!isSpace} />}
            </div>
            {pageOn('/notes') && (
              <div className="today-col today-note-col">
                {/* A new day is a new note: everything of yesterday's (its draft saved to it) goes with the old key. */}
                <TodayNote key={day} day={day} isSpace={isSpace} canWrite={canWrite} todos={todos} onOpenTask={open} />
              </div>
            )}
          </div>
        </div>
      </div>
      <SelectedTodo todos={todos} selectedId={selectedId} canWrite={canWrite} canComment={canComment} isSpace={isSpace} onClose={() => open(null)} />
      {todos.undoToast}
    </div>
  );
}

function SelectedTodo({ todos, selectedId, canWrite, canComment, isSpace, onClose }: {
  todos: TodosApi;
  selectedId: string | null;
  canWrite: boolean;
  canComment: boolean;
  isSpace: boolean;
  onClose: () => void;
}) {
  const selected = selectedId ? todos.tasks.find((t) => t.id === selectedId) ?? null : null;
  const lists = useMemo(() => [...new Set([...todos.savedLists, ...todos.tasks.filter((t) => t.category).map((t) => t.category as string)])].sort((a, b) => a.localeCompare(b)), [todos.savedLists, todos.tasks]);
  if (!selected) return null;
  return (
    <TodoDetail key={selected.id} task={selected} tasks={todos.tasks} todos={todos} lists={lists} roles={[]}
      canWrite={canWrite} canComment={canComment} isSpace={isSpace} onClose={onClose} />
  );
}

/** The day's to-dos: overdue, due today, My Day; done today folded; yesterday's picks offered again. */
function TodayTodos({ todos, now, day, canWrite, isSpace, selectedId, onOpen }: {
  todos: TodosApi;
  now: Date;
  day: string;
  canWrite: boolean;
  isSpace: boolean;
  selectedId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const { tasks } = todos;
  const parts = useMemo(() => todayParts(tasks, now, browserTimezone()), [tasks, now]);
  const lookup = useMemo(() => toLookup(tasks), [tasks]);
  const lists = useMemo(() => [...new Set([...todos.savedLists, ...tasks.filter((t) => t.category).map((t) => t.category as string)])], [todos.savedLists, tasks]);
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const toggle = (task: Todo) => {
    if (task.status === 'done') { void todos.toggle(task); return; }
    if (completing.has(task.id)) return;
    setCompleting((s) => new Set(s).add(task.id));
    setTimeout(() => {
      setCompleting((s) => { const n = new Set(s); n.delete(task.id); return n; });
      void todos.toggle(task);
    }, COMPLETE_MS);
  };
  const ctx: RowContext = { showList: true, showMyDay: false, showAssignee: isSpace, today: day };
  const row = (task: Todo) => (
    <TodoRow
      key={task.id}
      task={task}
      ctx={ctx}
      steps={subtaskProgress(task, tasks)}
      waiting={blockedText(task, lookup)}
      selected={selectedId === task.id}
      completing={completing.has(task.id)}
      canWrite={canWrite && task.status !== 'archived'}
      canStar={task.status !== 'archived'}
      draggable={false}
      tabIndex={0}
      onFocus={() => undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === ' ' && canWrite) { e.preventDefault(); toggle(task); }
        else if (e.key === 'Enter') { e.preventDefault(); onOpen(task.id); }
      }}
      onToggle={() => toggle(task)}
      onToggleImportant={() => void todos.update(task, { important: !task.important })}
      onOpen={() => onOpen(selectedId === task.id ? null : task.id)}
    />
  );
  const add = (todo: NewTodo) => todos.create({ myDay: true, ...todo });
  const groups: { key: string; title: string; icon: typeof Sun; rows: Todo[]; tone?: string }[] = [
    { key: 'overdue', title: 'Overdue', icon: AlarmClock, rows: parts.overdue, tone: 'text-error' },
    { key: 'due', title: 'Due today', icon: CalendarDays, rows: parts.due, tone: 'text-primary' },
    { key: 'picked', title: 'My Day', icon: Sun, rows: parts.picked },
  ];
  const open = parts.overdue.length + parts.due.length + parts.picked.length;
  return (
    <section className="today-section" aria-labelledby="today-todos-title" data-testid="today-todos">
      <div className="today-section-head">
        <h2 id="today-todos-title"><CircleCheck className="h-[18px] w-[18px] text-primary" aria-hidden />To-dos</h2>
        <span className="today-count">{todos.loading ? '' : open === 0 ? 'nothing left' : `${open} to do`}</span>
        <Link href="/tasks?list=my-day" className="today-more">All to-dos<ChevronRight className="h-4 w-4" /></Link>
      </div>
      {todos.error && (
        <p role="alert" className="mb-3 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
          {todos.error} <button type="button" className="underline" onClick={() => todos.setError('')}>Dismiss</button>
        </p>
      )}
      {canWrite && <CaptureBar lists={lists} onAdd={add} placeholder="Add a to-do for today" />}
      {todos.loading ? (
        <div className="flex items-center gap-2 px-1 py-4 text-sm text-on-surface-variant"><Loader2 className="h-4 w-4 animate-spin" />Loading to-dos…</div>
      ) : open === 0 ? (
        <p className="today-empty" data-testid="today-todos-empty">
          {parts.done.length > 0 ? 'All done for today. ' : 'A clear day. '}
          Add a to-do above, or press Q on any page.
        </p>
      ) : (
        <div className="todo-list">
          {groups.filter((g) => g.rows.length > 0).map((g) => (
            <div key={g.key} className="contents" data-testid={`today-group-${g.key}`}>
              <h3 className={cn('todo-group-title inline-flex items-center gap-1.5', g.tone)}><g.icon className="h-3.5 w-3.5" aria-hidden />{g.title} <span className="font-normal text-on-surface-variant">{g.rows.length}</span></h3>
              {g.rows.map(row)}
            </div>
          ))}
        </div>
      )}
      {!todos.loading && canWrite && (
        <MyDaySuggestions
          version={`${parts.picked.length}:${tasks.length}`}
          canWrite={canWrite}
          only="earlier"
          title="Still open from earlier"
          hideWhenEmpty
          onAdd={(t) => void todos.update(t, { myDay: true })}
        />
      )}
      {parts.done.length > 0 && (
        <>
          <button type="button" className="todo-section" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} data-testid="today-done-toggle">
            <span aria-hidden className={cn('inline-block transition-transform', showDone && 'rotate-90')}>›</span>
            Done today <span>{parts.done.length}</span>
          </button>
          {showDone && <div role="list" aria-label="Done today" className="todo-list">{parts.done.map(row)}</div>}
        </>
      )}
    </section>
  );
}

/** Today's calendar events, from the connected calendars (the Calendar page's own query). */
function TodayEvents({ day, now, personal }: { day: string; now: Date; personal: boolean }) {
  const workspace = useWorkspaceId();
  const events = useQuery({
    queryKey: calendarEventsKey(workspace, [day]),
    queryFn: () => fetchCalendarEvents([day]),
    staleTime: 60_000,
    retry: false,
    enabled: personal,
  });
  const list = useMemo(() => [...(events.data?.events ?? [])]
    .filter((e) => e.responseStatus !== 'declined')
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start)), [events.data]);
  const connected = !!events.data && (events.data.providers.length > 0 || events.data.partial);
  return (
    <section className="today-section" aria-labelledby="today-events-title" data-testid="today-events">
      <div className="today-section-head">
        <h2 id="today-events-title"><CalendarDays className="h-[18px] w-[18px] text-primary" aria-hidden />Calendar</h2>
        <span className="today-count">{connected ? (list.length === 0 ? 'nothing scheduled' : `${list.length} ${list.length === 1 ? 'event' : 'events'}`) : ''}</span>
        <Link href="/calendar" className="today-more">Calendar<ChevronRight className="h-4 w-4" /></Link>
      </div>
      {!personal ? (
        <p className="today-empty">Your connected calendars are personal: switch to your personal workspace to see today’s events here.</p>
      ) : events.isLoading ? (
        <div className="today-events" aria-busy="true">
          {[0, 1].map((i) => <div key={i} className="today-event is-skeleton"><span className="animate-pulse" /><span className="animate-pulse" /></div>)}
        </div>
      ) : events.isError ? (
        <p role="alert" className="today-empty">
          Today’s events could not be read ({events.error instanceof Error ? events.error.message : 'unavailable'}).{' '}
          <button type="button" className="inline-flex items-center gap-1 font-medium text-primary hover:underline" onClick={() => void events.refetch()}><RefreshCw className="h-3.5 w-3.5" />Try again</button>
        </p>
      ) : !connected ? (
        <p className="today-empty" data-testid="today-events-none">
          No calendar is connected. <Link href="/calendar" className="font-medium text-primary hover:underline">Connect Google or Microsoft 365</Link> to see your day here.
        </p>
      ) : list.length === 0 ? (
        <p className="today-empty">Nothing on the calendar today.</p>
      ) : (
        <ul className="today-events" aria-label="Today’s events">
          {list.map((event) => <EventRow key={eventKey(event)} event={event} now={now} />)}
        </ul>
      )}
      {events.data?.partial && <p className="mt-2 text-xs text-on-surface-variant">Some calendars could not be read just now; this may be missing events.</p>}
    </section>
  );
}

function EventRow({ event, now }: { event: CalendarEvent; now: Date }) {
  const start = Date.parse(event.start);
  const end = event.end ? Date.parse(event.end) : start;
  const past = !event.allDay && end < now.getTime();
  const current = !event.allDay && start <= now.getTime() && now.getTime() < end;
  return (
    <li className={cn('today-event', past && 'is-past', current && 'is-now')} data-testid="today-event">
      <span className="today-event-bar" style={{ background: colorOf(event) }} aria-hidden />
      <span className="today-event-time">{event.allDay ? 'All day' : timeLabel(event)}</span>
      <span className="min-w-0 flex-1">
        <span className="today-event-title">{event.title}</span>
        {(event.location || event.calendarName) && (
          <span className="today-event-meta">
            {event.location && <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{event.location}</span></span>}
            {!event.location && event.calendarName && <span className="truncate">{event.calendarName}</span>}
          </span>
        )}
      </span>
      {current && <span className="today-now">now</span>}
      {event.meetingUrl && /^https:\/\//i.test(event.meetingUrl) && !past && (
        <a href={event.meetingUrl} target="_blank" rel="noopener noreferrer" className="today-join" aria-label={`Join ${event.title}`}><Video className="h-3.5 w-3.5" />Join</a>
      )}
    </li>
  );
}

interface DailyResponse { note: NoteDetail | null; template: string }

/**
 * Today's daily note, written in place. Until something is typed there is
 * no note: the page shows the day's template, and the first keystroke makes
 * the note (`POST /notes/daily`) with the typed text saved over it. A
 * space's notes are live documents, made by "Start today's note".
 */
function TodayNote({ day, isSpace, canWrite, todos, onOpenTask }: {
  day: string;
  isSpace: boolean;
  canWrite: boolean;
  todos: TodosApi;
  onOpenTask: (id: string) => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const workspaceId = useWorkspaceId();
  const [noteId, setNoteId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>('edit');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const daily = useQuery<DailyResponse>({
    queryKey: ['note-daily', workspaceId, day],
    queryFn: () => api.get<DailyResponse>(`/notes/daily?date=${day}`),
  });
  const found = daily.data?.note && !daily.data.note.archivedAt ? daily.data.note.id : null;
  // The day's note, once it is known, is the one edited (adopted once: an archived one is not taken back).
  const [adopted, setAdopted] = useState<string | null>(null);
  if (found && !noteId && adopted !== found) {
    setAdopted(found);
    setNoteId(found);
  }
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['notes'] });
    void qc.invalidateQueries({ queryKey: ['note-index'] });
  }, [qc]);
  const makeDaily = useCallback(async () => (await api.post<{ note: NoteDetail }>('/notes/daily', { date: day })).note, [day]);
  const note = useNoteDraft({
    noteId,
    isSpace,
    canWrite,
    onCreated: setNoteId,
    onSaved: invalidate,
    // A personal note is made by its first save; a space note by "Start today's note".
    create: isSpace ? undefined : makeDaily,
  });
  // The day's note is in the archive: it stays there unless the user says otherwise (no seed, no auto-restore).
  const archivedId = !noteId && daily.data?.note?.archivedAt ? daily.data.note.id : null;
  // No note yet: the day's template, shown (not saved) until something is typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (!daily.data || daily.data.note || noteId || seeded.current || isSpace) return;
    seeded.current = true;
    note.startNew(undefined, { title: day, body: daily.data.template, kind: 'daily' });
  }, [daily.data, noteId, isSpace, note, day]);

  const noteTodos = useNoteTodos({
    noteId,
    draft: note,
    isSpace,
    canWrite: canWrite && !note.openArchived,
    onError: setError,
    onOpenTask,
    onMade: () => void todos.refetch(),
    showUndo: todos.showUndo,
    defaults: TODAY_TODO,
  });
  const index = useQuery<{ notes: NoteIndexEntry[] }>({ queryKey: ['note-index', workspaceId], queryFn: () => api.get('/notes/index') });
  const tagsQ = useQuery<{ tags: TagCount[] }>({ queryKey: ['note-tags', workspaceId], queryFn: () => api.get('/notes/tags') });
  const detail = noteId && note.detail.data?.id === noteId ? note.detail.data : undefined;

  /** One line into the note, at its end: typed into the draft (or the live text) like any other edit. */
  const [jot, setJot] = useState('');
  const capture = async () => {
    const text = jot.trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const line = `- ${time} ${text}`;
    if (note.editBody((body) => `${body.replace(/\s+$/, '')}\n${line}\n`)) { setJot(''); return; }
    // A space note before its live session: the server appends it.
    try {
      const res = await api.post<{ id: string }>('/notes/capture', { text, date: day });
      setJot('');
      if (!noteId) setNoteId(res.id);
      void qc.invalidateQueries({ queryKey: ['note', res.id] });
    } catch (err) {
      setError(err instanceof ApiError && err.body.code === 'archived'
        ? 'Today’s note is in the archive: restore it, or start a fresh one, to add to it.'
        : `Could not add the line: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Today's note is archived: bring it back, or start a fresh one beside it. */
  const fromArchive = async (how: 'restore' | 'fresh') => {
    setStarting(true);
    setError(null);
    try {
      const made = (await api.post<{ note: NoteDetail }>('/notes/daily', { date: day, [how]: true })).note;
      setNoteId(made.id);
      invalidate();
      void qc.invalidateQueries({ queryKey: ['note-daily', workspaceId, day] });
    } catch (err) {
      setError(`Could not ${how === 'restore' ? 'restore' : 'start'} today’s note: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarting(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const made = await makeDaily();
      setNoteId(made.id);
      void qc.invalidateQueries({ queryKey: ['note-daily', workspaceId, day] });
    } catch (err) {
      setError(`Could not start today’s note: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarting(false);
    }
  };

  /** Archive today's note (its last changes saved first), with Undo; the page then shows the day afresh. */
  const archive = async () => {
    const id = noteId;
    if (!id) return;
    if (note.personal && !(await note.flush()) && !window.confirm('This note could not be saved. Archive it without the latest changes?')) return;
    try {
      await api.delete(`/notes/${id}`);
    } catch (err) {
      setError(`Could not archive today’s note: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    note.clear();
    seeded.current = false;
    setNoteId(null);
    invalidate();
    void qc.invalidateQueries({ queryKey: ['note-daily', workspaceId, day] });
    todos.showUndo('Archived today’s note', () => {
      void api.post(`/notes/${id}/restore`, {}).then(() => {
        setNoteId(id);
        void qc.invalidateQueries({ queryKey: ['note-daily', workspaceId, day] });
      }, (err: unknown) => setError(`Could not restore it: ${err instanceof Error ? err.message : String(err)}`));
    });
  };

  const openSlug = (target: string) => {
    const wanted = target.trim().toLowerCase();
    const hit = (index.data?.notes ?? []).find((n) => n.slug === wanted || n.title.toLowerCase() === wanted || n.movedFrom?.includes(wanted));
    if (hit) router.push(`/notes?note=${encodeURIComponent(hit.id)}`);
    else setError(`No note “${target}” yet.`);
  };

  const readOnly = !canWrite || note.openArchived;
  const head = (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-1 text-[13px] font-semibold text-on-surface"><NotebookPen className="h-4 w-4 text-primary" aria-hidden />Today’s note</span>
  );
  const trailing = noteId ? (
    <Link href={`/notes?note=${encodeURIComponent(noteId)}`} className="notes-icon-btn" title="Open in Notes" aria-label="Open in Notes"><Maximize2 size={16} /></Link>
  ) : null;

  return (
    <section className="today-section today-note" aria-label="Today’s note" data-testid="today-note">
      {error && (
        <p role="alert" className="mb-2 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
          {error} <button type="button" className="underline" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}
      <div className="today-note-frame">
        {daily.isLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-on-surface-variant"><Loader2 className="h-4 w-4 animate-spin" />Opening today’s note…</div>
        ) : daily.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-on-surface-variant">
            <p role="alert">Today’s note could not be read: {daily.error instanceof Error ? daily.error.message : 'unavailable'}</p>
            <button type="button" className="notes-text-btn" onClick={() => void daily.refetch()}><RefreshCw size={14} />Try again</button>
          </div>
        ) : archivedId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-on-surface-variant" data-testid="today-note-archived">
            <p>Today’s note is in the archive.</p>
            {canWrite && (
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" className="notes-text-btn is-primary" disabled={starting} onClick={() => void fromArchive('restore')}>Restore it</button>
                <button type="button" className="notes-text-btn" disabled={starting} onClick={() => void fromArchive('fresh')}>Start a fresh one</button>
              </div>
            )}
          </div>
        ) : isSpace && !noteId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-on-surface-variant">
            <p>This space has no note for today yet.</p>
            {canWrite && <button type="button" className="notes-text-btn is-primary" disabled={starting} onClick={() => void start()}>{starting && <Loader2 className="animate-spin" size={14} />}Start today’s note</button>}
          </div>
        ) : (
          <NoteEditor
            selectedId={noteId}
            draftTitle={note.draft.title}
            setDraftTitle={note.setTitle}
            titleAuto={note.titleAuto}
            draftBody={note.draft.body}
            setDraftBody={note.setBody}
            draftTags={note.draft.tags}
            setDraftTags={note.setTags}
            draftKind={note.draft.kind}
            setDraftKind={note.setKind}
            draftFolder={note.draft.folder}
            setDraftFolder={note.setFolder}
            slug={detail?.slug}
            noteDate={detail?.noteDate ?? day}
            updatedAt={detail?.updatedAt}
            pinned={detail?.pinned ?? false}
            onTogglePin={() => {
              if (!noteId) return;
              void api.patch(`/notes/${noteId}/pin`, { pinned: !(detail?.pinned ?? false) }).then(() => qc.invalidateQueries({ queryKey: ['note', noteId] }), (err: unknown) => setError(String(err)));
            }}
            mode={mode}
            setMode={setMode}
            dirty={note.dirty}
            saving={note.saveDetails.isPending}
            onSave={note.saveNow}
            onArchive={() => void archive()}
            noteIndex={index.data?.notes ?? []}
            tags={tagsQ.data?.tags ?? []}
            onOpenSlug={openSlug}
            onTagClick={() => router.push('/notes')}
            onToggleTask={readOnly || !note.canEditBody ? undefined : note.toggleTask}
            readOnly={readOnly}
            live={note.live}
            liveLoading={isSpace && !!noteId && !note.liveSynced}
            autosave={note.autosave}
            onTitleEditing={note.setTitleEditing}
            leading={head}
            trailing={trailing}
            notices={note.draftNotice ? <DraftNoticeBar note={note} /> : null}
            todos={noteTodos}
          />
        )}
      </div>
      {canWrite && !daily.isLoading && !daily.isError && !archivedId && (!isSpace || noteId) && (
        <form className="today-jot" onSubmit={(e) => { e.preventDefault(); void capture(); }}>
          <input value={jot} onChange={(e) => setJot(e.target.value)} placeholder="Jot a line into today’s note…" aria-label="Jot a line into today’s note" maxLength={2000} />
          <button type="submit" disabled={!jot.trim()} className="notes-text-btn"><CornerDownLeft size={14} />Add</button>
        </form>
      )}
    </section>
  );
}
