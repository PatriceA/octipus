'use client';

import { ArrowLeft, Bell, Bot, CalendarDays, ChevronDown, Flag, List, PanelRightClose, Plus, Repeat, RotateCcw, Sun, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AssigneeEditor, CommentsThread, LeaseBadge, ReleaseClaimButton } from '@/components/tasks/work-board';
import { cn } from '@/lib/utils';
import { REPEAT_PRESETS, repeatLabel, type TaskRepeat } from '../../../src/core/tasks/repeat';
import { isActiveStatus, TASK_STATUS_TITLE, type TaskStatus } from '../../../src/core/tasks/status';
import {
  dayFromToday, dueDateInput, dueText, dueTimeInput, dueValue, localDateTimeInput, localToday, nextMonday,
  PRIORITY_LABEL, remindText, type Todo, type TodoPatch,
} from './model';
import { TodoLinkedNotes, TodoNotesField } from './todo-notes';
import { StarButton, TodoCheck } from './todo-row';
import type { TodosApi } from './use-todos';

const WEEKDAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A text field that saves itself: on blur and Enter (single line), or a
 * moment after typing stops (notes). It follows the task while it is not
 * being edited, keeps the draft when a save fails and says so.
 */
function useSavedText(value: string, save: (next: string) => Promise<unknown>, delayMs: number | null, required = false) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [seeded, setSeeded] = useState(value);
  if (!editing && !failed && seeded !== value) {
    setSeeded(value);
    setDraft(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ draft, value, save });
  useEffect(() => { latest.current = { draft, value, save }; });
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { draft: d, value: v, save: s } = latest.current;
    if (d === v) { setFailed(false); return; }
    // A title cannot be emptied: put the saved one back.
    if (required && !d.trim()) { setDraft(v); setFailed(false); return; }
    const ok = await s(d);
    setFailed(ok === undefined);
    if (ok !== undefined) setSeeded(d);
  };
  // Leaving the to-do (another one opened, the panel closed) saves what was typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- on unmount only; flush reads the latest values through a ref
  useEffect(() => () => { void flush(); }, []);
  return {
    draft,
    failed,
    onChange: (next: string) => {
      setDraft(next);
      setEditing(true);
      if (delayMs !== null) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), delayMs);
      }
    },
    onBlur: () => { setEditing(false); void flush(); },
    flush,
  };
}

/** One row of a card that opens a set of quick picks under it. */
function PickRow({ icon: Icon, label, set, open, onOpen, onClear, children, testId }: {
  icon: typeof Sun;
  label: string;
  set: boolean;
  open: boolean;
  onOpen: () => void;
  onClear?: () => void;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <div className="flex items-center pr-2">
        <button type="button" onClick={onOpen} aria-expanded={open} className={cn('todo-card-row', set && 'is-set')}>
          <Icon aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
        {set && onClear && (
          <button type="button" onClick={onClear} aria-label={`Clear: ${label}`} className="todo-clear"><X className="h-4 w-4" /></button>
        )}
      </div>
      {open && children && <div className="todo-picks">{children}</div>}
    </div>
  );
}

function Pick({ onClick, pressed, children }: { onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return <button type="button" className="todo-pick" aria-pressed={pressed} onClick={onClick}>{children}</button>;
}

/**
 * The right-hand panel of a to-do (after Microsoft To Do): title, steps, My
 * Day, reminder, due date and time, repeat, list, priority and notes; then the
 * board and agent fields (status, assignee, estimate, claim, comments), which
 * the list rows no longer show. Every field saves as it is changed.
 */
export function TodoDetail({ task, tasks, todos, lists, roles, canWrite, canComment, isSpace, onClose }: {
  task: Todo;
  tasks: readonly Todo[];
  todos: TodosApi;
  lists: readonly string[];
  roles: readonly string[];
  canWrite: boolean;
  canComment: boolean;
  isSpace: boolean;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState<'remind' | 'due' | 'repeat' | null>(null);
  const [customRepeat, setCustomRepeat] = useState(false);
  const [stepTitle, setStepTitle] = useState('');
  const patch = (p: TodoPatch) => todos.update(task, p);
  const title = useSavedText(task.title, (next) => patch({ title: next.trim() }), null, true);
  const notes = useSavedText(task.notes ?? '', (next) => patch({ notes: next || null }), 900);
  const steps = tasks.filter((t) => t.parentId === task.id && t.status !== 'archived').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const today = localToday();
  const inMyDay = task.myDayOn === today;
  const archived = task.status === 'archived';
  const due = task.dueAt ? dueText(task.dueAt) : null;
  const toggle = (which: 'remind' | 'due' | 'repeat') => setPicking((p) => (p === which ? null : which));
  const setDue = (day: string, time?: string | null) => { void patch({ dueAt: dueValue(day, time) }); };
  const setRepeat = (rule: TaskRepeat | null) => {
    // A repeat needs a day to count from: today, as Microsoft To Do does.
    void patch(rule && !task.dueAt ? { repeat: rule, dueAt: today } : { repeat: rule });
    if (!rule) setCustomRepeat(false);
  };
  const addStep = async () => {
    const t = stepTitle.trim();
    if (!t) return;
    setStepTitle('');
    await todos.create({ title: t, parentId: task.id, ...(task.category ? { category: task.category } : {}), sortOrder: (steps.at(-1)?.sortOrder ?? 0) + 1024 });
  };
  const remindPicks = (() => {
    const now = new Date();
    const later = new Date(now);
    later.setHours(later.getHours() + 3, 0, 0, 0);
    const picks: { label: string; at: string }[] = [];
    if (later.getDate() === now.getDate() && later.getHours() <= 21) picks.push({ label: `Later today (${later.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`, at: later.toISOString() });
    picks.push({ label: 'Tomorrow 9:00', at: dueValue(dayFromToday(1), '09:00') });
    picks.push({ label: 'Next week 9:00', at: dueValue(nextMonday(), '09:00') });
    return picks;
  })();
  const rule = task.repeat ?? null;

  return (
    <aside className="todo-detail" aria-label="To-do details" data-testid="todo-detail">
      <div className="todo-detail-top">
        <button type="button" onClick={onClose} className="todo-tool" aria-label="Back to list"><ArrowLeft className="h-5 w-5" /></button>
      </div>
      <div className="todo-detail-scroll">
        {/* Title and steps */}
        <section className="todo-card" aria-label="To-do">
          <div className="flex items-start gap-1 py-1.5 pl-1 pr-1">
            <TodoCheck task={task} onToggle={() => void todos.toggle(task)} disabled={!canWrite || archived} />
            <textarea
              aria-label="Title"
              rows={1}
              value={title.draft}
              readOnly={!canWrite}
              onChange={(e) => title.onChange(e.target.value.replace(/\n/g, ''))}
              onBlur={title.onBlur}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
              maxLength={500}
              className={cn('mt-[7px] min-w-0 flex-1 resize-none bg-transparent text-[17px] font-semibold leading-snug text-on-surface [field-sizing:content] focus:outline-none', task.status === 'done' && 'text-on-surface-variant line-through')}
            />
            <StarButton important={!!task.important} onToggle={() => void patch({ important: !task.important })} disabled={archived} />
          </div>
          {title.failed && <p role="alert" className="px-4 pb-2 text-xs text-error">Title not saved. Your text is still here; click away to try again.</p>}
          {steps.length > 0 && (
            <ul aria-label="Steps" className="pb-1">
              {steps.map((step) => <StepRow key={step.id} step={step} todos={todos} canWrite={canWrite} />)}
            </ul>
          )}
          {canWrite && !archived && (
            <div className="flex items-center gap-3 px-3.5">
              <Plus className="h-[18px] w-[18px] shrink-0 text-primary" aria-hidden />
              <input
                value={stepTitle}
                onChange={(e) => setStepTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addStep(); }}
                aria-label={steps.length ? 'Next step' : 'Add step'}
                placeholder={steps.length ? 'Next step' : 'Add step'}
                maxLength={500}
                className="h-11 min-w-0 flex-1 bg-transparent text-sm text-on-surface placeholder:text-primary focus:outline-none"
              />
            </div>
          )}
        </section>

        {/* My Day is the reader's own, in a space too: any reader may pick it. */}
        {!archived && (
              <section className="todo-card">
                <div className="flex items-center pr-2">
                  <button type="button" onClick={() => void patch({ myDay: !inMyDay })} className={cn('todo-card-row', inMyDay && 'is-set')}>
                    <Sun aria-hidden /><span>{inMyDay ? 'Added to My Day' : 'Add to My Day'}</span>
                  </button>
                  {inMyDay && <button type="button" className="todo-clear" aria-label="Remove from My Day" onClick={() => void patch({ myDay: false })}><X className="h-4 w-4" /></button>}
                </div>
              </section>
        )}
        {canWrite && !archived && (
          <>

            <section className="todo-card" aria-label="Dates">
              <PickRow icon={Bell} testId="todo-remind" label={task.remindAt ? `Remind me ${remindText(task.remindAt)}` : 'Remind me'} set={!!task.remindAt}
                open={picking === 'remind'} onOpen={() => toggle('remind')} onClear={() => void patch({ remindAt: null })}>
                {remindPicks.map((p) => <Pick key={p.label} onClick={() => { void patch({ remindAt: p.at }); setPicking(null); }}>{p.label}</Pick>)}
                <input type="datetime-local" aria-label="Reminder date and time" className="todo-field" value={localDateTimeInput(task.remindAt)}
                  onChange={(e) => e.target.value && void patch({ remindAt: new Date(e.target.value).toISOString() })} />
              </PickRow>
              <PickRow icon={CalendarDays} testId="todo-due" label={due ? `Due ${due.text}` : 'Add due date'} set={!!task.dueAt}
                open={picking === 'due'} onOpen={() => toggle('due')} onClear={() => void patch({ dueAt: null })}>
                <Pick pressed={dueDateInput(task.dueAt) === today} onClick={() => { setDue(today, dueTimeInput(task.dueAt)); setPicking(null); }}>Today</Pick>
                <Pick pressed={dueDateInput(task.dueAt) === dayFromToday(1)} onClick={() => { setDue(dayFromToday(1), dueTimeInput(task.dueAt)); setPicking(null); }}>Tomorrow</Pick>
                <Pick pressed={dueDateInput(task.dueAt) === nextMonday()} onClick={() => { setDue(nextMonday(), dueTimeInput(task.dueAt)); setPicking(null); }}>Next week</Pick>
                <div className="flex w-full flex-wrap gap-2 pt-1">
                  <input type="date" aria-label="Due date" className="todo-field" value={dueDateInput(task.dueAt)}
                    onChange={(e) => e.target.value && setDue(e.target.value, dueTimeInput(task.dueAt))} />
                  <input type="time" aria-label="Due time" className="todo-field" value={dueTimeInput(task.dueAt)}
                    onChange={(e) => setDue(dueDateInput(task.dueAt) || today, e.target.value || null)} />
                </div>
              </PickRow>
              <PickRow icon={Repeat} testId="todo-repeat" label={rule ? repeatLabel(rule) : 'Repeat'} set={!!rule}
                open={picking === 'repeat'} onOpen={() => toggle('repeat')} onClear={() => setRepeat(null)}>
                {(Object.keys(REPEAT_PRESETS) as (keyof typeof REPEAT_PRESETS)[]).map((name) => {
                  const preset: TaskRepeat = REPEAT_PRESETS[name];
                  const on = !!rule && repeatLabel(rule) === repeatLabel(preset);
                  return <Pick key={name} pressed={on} onClick={() => { setRepeat({ ...preset, ...(preset.weekdays ? { weekdays: [...preset.weekdays] } : {}) }); setPicking(null); }}>{repeatLabel(preset)}</Pick>;
                })}
                <Pick pressed={customRepeat} onClick={() => setCustomRepeat((v) => !v)}>Custom</Pick>
                {customRepeat && <CustomRepeat rule={rule} onChange={setRepeat} />}
              </PickRow>
            </section>

            <section className="todo-card" aria-label="List and priority">
              <label className="todo-card-row cursor-default">
                <List aria-hidden />
                <span className="sr-only">Move to list</span>
                <select aria-label="Move to list" value={task.category ?? ''} onChange={(e) => void patch({ category: e.target.value || null })}
                  className="min-w-0 flex-1 cursor-pointer rounded-md border-0 bg-transparent py-1 text-sm text-on-surface">
                  <option value="">No list</option>
                  {[...new Set([...lists, ...(task.category ? [task.category] : [])])].map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <div className="todo-card-row cursor-default" role="group" aria-label="Priority">
                <Flag aria-hidden />
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {PRIORITY_LABEL.map((label, value) => (
                    <button key={label} type="button" aria-pressed={task.priority === value} onClick={() => void patch({ priority: value })}
                      className={cn('todo-pick', value === 3 && task.priority === 3 && '!border-error !bg-error-container !text-on-error-container')}>{label}</button>
                  ))}
                </div>
              </div>
            </section>
          </>
        )}

        <TodoNotesField value={notes.draft} onChange={notes.onChange} onBlur={notes.onBlur} canWrite={canWrite} failed={notes.failed} />

        <TodoLinkedNotes task={task} canWrite={canWrite && !archived} onChanged={todos.refetch} onError={todos.setError} />

        <BoardFieldsCard task={task} tasks={tasks} todos={todos} roles={roles} canWrite={canWrite} canComment={canComment} defaultOpen={isSpace} />
      </div>
      <footer className="todo-detail-footer">
        <button type="button" onClick={onClose} className="todo-tool todo-detail-close" aria-label="Close details" title="Close (Esc)"><PanelRightClose className="h-[18px] w-[18px]" /></button>
        <span className="min-w-0 flex-1 truncate text-center">
          {task.status === 'done' && task.completedAt ? `Completed ${new Date(task.completedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
            : `Created ${new Date(task.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`}
        </span>
        {canWrite && (archived ? (
          <button type="button" className="todo-tool" onClick={() => void todos.restore(task)}><RotateCcw className="h-4 w-4" />Restore</button>
        ) : (
          <button type="button" className="todo-tool hover:!text-error" aria-label="Delete task" title="Delete (Del)" onClick={() => { todos.remove(task); onClose(); }}>
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
        ))}
      </footer>
    </aside>
  );
}

function StepRow({ step, todos, canWrite }: { step: Todo; todos: TodosApi; canWrite: boolean }) {
  const text = useSavedText(step.title, (next) => todos.update(step, { title: next.trim() }), null, true);
  return (
    <li className="group flex items-center gap-1 pl-1 pr-2" data-testid="todo-step">
      <TodoCheck task={step} size="sm" onToggle={() => void todos.setStatus(step, step.status === 'done' ? 'open' : 'done')} disabled={!canWrite} />
      <input
        aria-label="Step"
        value={text.draft}
        readOnly={!canWrite}
        onChange={(e) => text.onChange(e.target.value)}
        onBlur={text.onBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className={cn('h-10 min-w-0 flex-1 bg-transparent text-sm text-on-surface focus:outline-none', step.status === 'done' && 'text-on-surface-variant line-through')}
      />
      {canWrite && (
        <button type="button" aria-label={`Remove step ${step.title}`} onClick={() => todos.remove(step)}
          className="todo-clear opacity-0 group-hover:opacity-100 focus:opacity-100"><X className="h-4 w-4" /></button>
      )}
    </li>
  );
}

function CustomRepeat({ rule, onChange }: { rule: TaskRepeat | null; onChange: (r: TaskRepeat) => void }) {
  const [interval, setInterval] = useState(rule?.interval ?? 1);
  const [unit, setUnit] = useState<TaskRepeat['unit']>(rule?.unit ?? 'week');
  const [days, setDays] = useState<number[]>(rule?.weekdays ?? []);
  const apply = (next: { interval?: number; unit?: TaskRepeat['unit']; days?: number[] }) => {
    const n = Math.max(1, Math.min(365, Math.trunc(next.interval ?? interval) || 1));
    const u = next.unit ?? unit;
    const d = next.days ?? days;
    setInterval(n);
    setUnit(u);
    setDays(d);
    onChange({ unit: u, interval: n, ...(u === 'week' && d.length > 0 ? { weekdays: d } : {}) });
  };
  return (
    <div className="flex w-full flex-col gap-2 pt-1" data-testid="todo-repeat-custom">
      <div className="flex items-center gap-2 text-sm text-on-surface">
        <span>Every</span>
        <input type="number" min={1} max={365} aria-label="Repeat every" value={interval} onChange={(e) => apply({ interval: Number(e.target.value) })} className="todo-field w-16" />
        <select aria-label="Repeat unit" value={unit} onChange={(e) => apply({ unit: e.target.value as TaskRepeat['unit'] })} className="todo-field">
          {(['day', 'week', 'month', 'year'] as const).map((u) => <option key={u} value={u}>{interval === 1 ? u : `${u}s`}</option>)}
        </select>
      </div>
      {unit === 'week' && (
        <div className="flex gap-1" role="group" aria-label="On days">
          {WEEKDAY_SHORT.map((d, i) => (
            <button key={i} type="button" aria-label={WEEKDAY_NAME[i]} aria-pressed={days.includes(i)}
              onClick={() => apply({ days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() })}
              className={cn('grid h-8 w-8 place-items-center rounded-full border text-xs font-semibold', days.includes(i) ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant text-on-surface-variant hover:border-primary')}>
              {d}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Board and agent fields: status (in progress), assignee, estimate, the
 * claim an agent holds, what it waits on, where it came from, and the comment
 * thread. Collapsed on the personal list (they are agent machinery), open in
 * a space.
 */
function BoardFieldsCard({ task, tasks, todos, roles, canWrite, canComment, defaultOpen }: {
  task: Todo;
  tasks: readonly Todo[];
  todos: TodosApi;
  roles: readonly string[];
  canWrite: boolean;
  canComment: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || !!task.checkedOutBy);
  const [estimate, setEstimate] = useState(task.estimate ?? '');
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : null;
  const blockers = (task.blockedBy ?? []).map((id) => tasks.find((t) => t.id === id)).filter((t): t is Todo => !!t && isActiveStatus(t.status));
  return (
    <section className="todo-card" data-testid="todo-board-fields">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="todo-card-row">
        <Bot aria-hidden />
        <span className="flex-1">Board &amp; agents</span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 px-4 py-3 text-sm text-on-surface">
          <div className="flex flex-wrap items-center gap-2">
            <label className="todo-label" htmlFor={`status-${task.id}`}>Status</label>
            <select id={`status-${task.id}`} aria-label="Status" value={task.status} disabled={!canWrite}
              onChange={(e) => void todos.setStatus(task, e.target.value as TaskStatus)} className="todo-field">
              {(Object.keys(TASK_STATUS_TITLE) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_TITLE[s]}</option>)}
            </select>
            <label className="todo-label ml-2" htmlFor={`estimate-${task.id}`}>Estimate</label>
            <input id={`estimate-${task.id}`} aria-label="Estimate" value={estimate} readOnly={!canWrite} placeholder="S / M / 3h" maxLength={40}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => { if (estimate.trim() !== (task.estimate ?? '')) void todos.update(task, { estimate: estimate.trim() || null }); }}
              className="todo-field w-24" />
          </div>
          <div className="space-y-1.5">
            <p className="todo-label">Assigned to</p>
            {canWrite
              ? <AssigneeEditor task={task} roles={roles} onChange={(p) => void todos.update(task, p)} />
              : <p className="text-on-surface-variant">{task.assigneeRef ?? 'Nobody'}</p>}
            <p className="text-xs text-on-surface-variant">Assign to a role for background work; its agent picks the to-do up.</p>
          </div>
          {(task.checkedOutBy || task.leaseExpiresAt) && (
            <div className="flex items-center gap-3">
              <LeaseBadge task={task} />
              {canWrite && <ReleaseClaimButton task={task} onRelease={() => void todos.release(task)} />}
            </div>
          )}
          {parent && <p className="text-xs text-on-surface-variant">Step of “{parent.title}”</p>}
          {blockers.length > 0 && <p className="text-xs text-error">Waiting on {blockers.map((b) => `“${b.title}”`).join(', ')}</p>}
          {task.source !== 'user' && <p className="text-xs text-on-surface-variant">Added by {task.source}</p>}
          <CommentsThread taskId={task.id} indent={false} canComment={canComment} />
        </div>
      )}
    </section>
  );
}
