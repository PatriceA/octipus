'use client';

import { ArrowLeft, ArrowRight, Columns3, CornerDownRight, List, Lock, NotebookPen, Pencil, Plus, RefreshCw, Ruler, Sparkles, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { NEXT_BUCKET_ORDER, NEXT_BUCKET_TITLE, type NextBucket } from '../../../src/core/tasks/rank';
import { isActiveStatus, TASK_STATUS_TITLE, type TaskStatus } from '../../../src/core/tasks/status';
import { type Nested, nestTasks, toLookup, waitingOn, waitingReason } from '../../../src/core/tasks/structure';

interface Task {
  id: string;
  title: string;
  notes?: string | null;
  status: TaskStatus;
  priority: number;
  category?: string | null;
  estimate?: string | null;
  parentId?: string | null;
  blockedBy?: string[] | null;
  dueAt?: string | null;
  completedAt?: string | null;
  source: string;
  createdAt: string;
  /** Present only on the `?view=next` response. */
  bucket?: NextBucket;
  reason?: string;
}

const PRIORITY = ['none', 'low', 'medium', 'high'] as const;
type GroupBy = 'next' | 'priority' | 'due' | 'category' | 'none';
type View = 'list' | 'board';
/** The board's lanes, left to right. Archived stays out of the way, as in the list. */
const BOARD_COLUMNS: readonly TaskStatus[] = ['open', 'in_progress', 'done'];
const VIEW_KEY = 'octipus.tasks.view';

/** Patchable fields a row can edit inline (besides notes/status). */
type TaskPatch = Partial<Pick<Task, 'priority' | 'category' | 'dueAt' | 'estimate'>>;

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

/** One-line "why can't I start this" for a task, judged against everything on the page. */
function waitingText(task: Task, lookup: ReadonlyMap<string, Task>): string | null {
  return waitingReason(waitingOn(task, lookup));
}

/** Sub-task progress for a parent: done out of all, or null when it has none. */
function subtaskProgress(task: Task, all: readonly Task[]): { done: number; total: number } | null {
  const kids = all.filter((t) => t.parentId === task.id);
  if (kids.length === 0) return null;
  return { done: kids.filter((t) => !isActiveStatus(t.status)).length, total: kids.length };
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function priorityClasses(p: number): string {
  if (p >= 3) return 'text-error';
  if (p === 2) return 'text-primary';
  if (p === 1) return 'text-on-surface-variant';
  return 'text-on-surface-variant/60';
}

/**
 * Parse a task dueAt to epoch ms. Date-only strings (`YYYY-MM-DD`, which the
 * tasks tool accepts) are interpreted in LOCAL time at noon — `new Date(...)`
 * would read them as UTC midnight, pushing same-day tasks into "Overdue" for
 * users west of UTC. Returns NaN for unparseable values.
 */
function dueMs(dueAt: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    const [y, m, d] = dueAt.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
  }
  return new Date(dueAt).getTime();
}

function dueLabel(dueAt?: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const ms = dueMs(dueAt);
  if (Number.isNaN(ms)) return null;
  const overdue = ms < Date.now();
  return { text: new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), overdue };
}

/** Bucket open tasks into ordered, labelled groups for the chosen grouping. */
function groupOpenTasks(tasks: Task[], by: GroupBy): { key: string; title: string; tasks: Task[] }[] {
  if (by === 'none') {
    return [{ key: 'open', title: `Open (${tasks.length})`, tasks }];
  }

  if (by === 'next') {
    // The server ranked these (`?view=next`); keep its order inside each
    // bucket. A task the ranked response did not cover (it never happens
    // after a complete fetch, but a stale merge could) lands in Backlog
    // rather than vanishing.
    return NEXT_BUCKET_ORDER
      .map((key) => ({ key: `n:${key}`, title: NEXT_BUCKET_TITLE[key], tasks: tasks.filter((t) => (t.bucket ?? 'backlog') === key) }))
      .filter((g) => g.tasks.length > 0)
      .map((g) => ({ ...g, title: `${g.title} (${g.tasks.length})` }));
  }

  if (by === 'priority') {
    const order = [3, 2, 1, 0];
    return order
      .map((p) => ({
        key: `p${p}`,
        title: PRIORITY[p].charAt(0).toUpperCase() + PRIORITY[p].slice(1),
        tasks: tasks.filter((t) => t.priority === p),
      }))
      .filter((g) => g.tasks.length > 0)
      .map((g) => ({ ...g, title: `${g.title} (${g.tasks.length})` }));
  }

  if (by === 'category') {
    // Distinct categories, alphabetical, with "Uncategorized" pinned last.
    const named = [...new Set(tasks.map((t) => t.category?.trim()).filter((c): c is string => !!c))].sort(
      (a, b) => a.localeCompare(b),
    );
    const groups = named.map((c) => ({
      key: `c:${c}`,
      title: c,
      tasks: tasks.filter((t) => (t.category?.trim() || '') === c),
    }));
    const uncategorized = tasks.filter((t) => !t.category?.trim());
    if (uncategorized.length > 0) groups.push({ key: 'c:', title: 'Uncategorized', tasks: uncategorized });
    return groups.filter((g) => g.tasks.length > 0).map((g) => ({ ...g, title: `${g.title} (${g.tasks.length})` }));
  }

  // by === 'due' — Overdue / Today / This week / Later / No date. Boundaries
  // are wall-clock day-ends (not rolling 24h windows) so "This week" means
  // "by the end of the 7th day", consistent across DST.
  const now = Date.now();
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const endOfWeek = new Date();
  endOfWeek.setDate(endOfWeek.getDate() + 7);
  endOfWeek.setHours(23, 59, 59, 999);
  const bucket = (t: Task): string => {
    if (!t.dueAt) return 'none';
    const d = dueMs(t.dueAt);
    if (Number.isNaN(d)) return 'none';
    if (d < now) return 'overdue';
    if (d <= endOfToday.getTime()) return 'today';
    if (d <= endOfWeek.getTime()) return 'week';
    return 'later';
  };
  const defs: { key: string; title: string }[] = [
    { key: 'overdue', title: 'Overdue' },
    { key: 'today', title: 'Today' },
    { key: 'week', title: 'This week' },
    { key: 'later', title: 'Later' },
    { key: 'none', title: 'No date' },
  ];
  return defs
    .map((d) => ({ key: d.key, title: d.title, tasks: tasks.filter((t) => bucket(t) === d.key) }))
    .filter((g) => g.tasks.length > 0)
    .map((g) => ({ ...g, title: `${g.title} (${g.tasks.length})` }));
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState(0);
  const [newCategory, setNewCategory] = useState('');
  const [newDue, setNewDue] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('next');
  const [view, setView] = useState<View>(readView);
  const chooseView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* per-viewer convenience only */
    }
  };

  // "next" is ranked server-side (bucket + reason per task, day boundaries in
  // the browser's timezone); the ranked list only carries open tasks, so the
  // done section still comes from the plain list. Both requests go out at
  // once, and a response from an earlier fetch is dropped so a slow reply
  // cannot overwrite a newer one.
  const fetchSeq = useRef(0);
  const fetchTasks = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const tz = browserTimezone();
      const [data, next] = await Promise.all([
        api.get<{ tasks: Task[] }>('/tasks'),
        groupBy === 'next' ? api.get<{ tasks: Task[] }>(`/tasks?view=next&tz=${encodeURIComponent(tz)}`) : Promise.resolve(null),
      ]);
      if (seq !== fetchSeq.current) return;
      let all = data.tasks || [];
      if (next) {
        const ranked = new Map((next.tasks || []).map((t, i) => [t.id, { ...t, rank: i }]));
        all = all
          .map((t) => (ranked.has(t.id) ? { ...t, bucket: ranked.get(t.id)!.bucket, reason: ranked.get(t.id)!.reason } : t))
          .sort((a, b) => (ranked.get(a.id)?.rank ?? Infinity) - (ranked.get(b.id)?.rank ?? Infinity));
      }
      setTasks(all);
      setError('');
    } catch (err) {
      if (seq === fetchSeq.current) setError((err as Error).message);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [groupBy]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load tasks once on mount; fetchTasks sets state from the server
    fetchTasks();
  }, [fetchTasks]);

  // `opts.title`/`opts.category` come from a per-group inline add (grouping by
  // category) so the new task lands in that group; the top quick-add passes
  // neither and uses its own inputs (which it then clears).
  const addTask = async (opts?: { title?: string; category?: string }) => {
    const title = (opts?.title ?? newTitle).trim();
    if (!title) return;
    try {
      await api.post('/tasks', {
        title,
        priority: opts?.title ? 0 : newPriority,
        category: (opts?.category ?? newCategory).trim() || undefined,
        dueAt: opts?.title ? undefined : newDue || undefined,
        // The date picker sends a bare day; the server ends it in THIS zone.
        tz: browserTimezone(),
      });
      if (!opts?.title) {
        setNewTitle('');
        setNewPriority(0);
        setNewCategory('');
        setNewDue('');
      }
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Generic field patch (priority/category/dueAt) used by the inline row editor.
  // Optimistic so the row reflects the change before the request resolves.
  const updateFields = async (task: Task, patch: TaskPatch) => {
    setTasks((xs) => xs.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
    try {
      await api.patch(`/tasks/${task.id}`, patch.dueAt !== undefined ? { ...patch, tz: browserTimezone() } : patch);
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Status moves (the checkbox, the board's drag and arrows, the row's status
  // picker) all go through here. Optimistic so a dragged card lands at once.
  const setStatus = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return;
    setTasks((xs) => xs.map((t) => (t.id === task.id ? { ...t, status } : t)));
    try {
      await api.patch(`/tasks/${task.id}`, { status });
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message);
      await fetchTasks();
    }
  };

  const toggleDone = (task: Task) => setStatus(task, task.status === 'done' ? 'open' : 'done');

  const updateNotes = async (task: Task, notes: string) => {
    // Optimistic: update local state immediately so the prop reflects the new
    // value before the request resolves. This also makes a redundant second
    // save (e.g. blur + click) a no-op against the saver's own equality guard.
    setTasks((xs) => xs.map((t) => (t.id === task.id ? { ...t, notes } : t)));
    try {
      await api.patch(`/tasks/${task.id}`, { notes });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteTask = async (id: string) => {
    if (!confirm('Delete this task?')) return;
    try {
      await api.delete(`/tasks/${id}`);
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  const openTasks = tasks.filter((t) => isActiveStatus(t.status));
  const done = tasks.filter((t) => t.status === 'done');
  const openGroups = groupOpenTasks(openTasks, groupBy);
  // Blockers and parents are looked up across every task on the page, so a
  // blocked task says so whichever group its blocker sits in.
  const lookup = toLookup(tasks);
  // Existing categories across all tasks — offered for reuse in inputs so the
  // user doesn't have to remember exact spellings (the QA: "how should I know
  // all the titles").
  const categories = [...new Set(tasks.map((t) => t.category?.trim()).filter((c): c is string => !!c))].sort(
    (a, b) => a.localeCompare(b),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="tasks"
        description="your to-do list — agents can add, complete, and surface to-do items here"
      />

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Quick add */}
      <datalist id="task-categories">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          placeholder="Add a task…"
          className="flex-1 min-w-[12rem] rounded-full border border-outline-variant/20 bg-surface px-4 py-2 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
        />
        <input
          type="text"
          list="task-categories"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          placeholder="Category…"
          title="Optional list/category, e.g. Shopping or Car"
          className="w-36 rounded-full border border-outline-variant/20 bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
        />
        <input
          type="date"
          value={newDue}
          onChange={(e) => setNewDue(e.target.value)}
          title="Optional due date"
          className="rounded-full border border-outline-variant/20 bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary"
        />
        <select
          value={newPriority}
          onChange={(e) => setNewPriority(Number(e.target.value))}
          className="rounded-full border border-outline-variant/20 bg-surface px-3 py-2 text-sm text-on-surface"
        >
          {PRIORITY.map((label, i) => (
            <option key={label} value={i}>{label}</option>
          ))}
        </select>
        <button
          onClick={() => addTask()}
          className="px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 flex items-center gap-2 font-medium"
        >
          <Plus className="w-4 h-4" /> Add
        </button>
      </div>

      {/* View + grouping controls */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
        <div className="inline-flex rounded-full border border-outline-variant/20 p-0.5" role="group" aria-label="View">
          {(['list', 'board'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => chooseView(v)}
              aria-pressed={view === v}
              data-testid={`tasks-view-${v}`}
              className={`px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1 ${view === v ? 'bg-primary/10 text-primary' : 'hover:bg-surface-container-high'}`}
            >
              {v === 'list' ? <List className="w-3 h-3" /> : <Columns3 className="w-3 h-3" />} {v}
            </button>
          ))}
        </div>
        {view === 'list' && (
          <>
            <span className="ml-2">Group by</span>
            {(['next', 'priority', 'due', 'category', 'none'] as GroupBy[]).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`px-2.5 py-1 rounded-full text-xs capitalize ${groupBy === g ? 'bg-primary/10 text-primary' : 'hover:bg-surface-container-high'}`}
              >
                {g === 'none' ? 'nothing' : g === 'next' ? 'what next' : g}
              </button>
            ))}
          </>
        )}
        {view === 'board' && <span className="ml-2 text-xs">columns by status, lanes by category — drag a card, or use its arrows</span>}
      </div>

      {view === 'board' ? (
        <TaskBoard
          tasks={tasks.filter((t) => t.status !== 'archived')}
          lookup={lookup}
          onSetStatus={setStatus}
          onDelete={deleteTask}
        />
      ) : openTasks.length === 0 ? (
        <div className="py-10 text-center font-mono animate-enter">
          <p aria-hidden className="text-2xl text-on-surface-variant/40">[ ]</p>
          <p className="mt-2 text-sm text-on-surface-variant/70">nothing to do — add a task above, or ask an agent to remind you</p>
        </div>
      ) : (
        openGroups.map((g) => (
          <TaskGroup
            key={g.key}
            title={g.title}
            tasks={g.tasks}
            lookup={lookup}
            onToggle={toggleDone}
            onSetStatus={setStatus}
            onDelete={deleteTask}
            onUpdateNotes={updateNotes}
            onUpdateFields={updateFields}
            // When grouping by category, a group "+ add" files the new task
            // straight into that category (the QA: "in the groups the user can
            // create todos"). `c:` key prefix → the category text after it.
            onAddToCategory={groupBy === 'category' && g.key.startsWith('c:') ? (title) => addTask({ title, category: g.key.slice(2) }) : undefined}
          />
        ))
      )}

      {view === 'list' && done.length > 0 && (
        <TaskGroup title={`Done (${done.length})`} tasks={done} lookup={lookup} onToggle={toggleDone} onSetStatus={setStatus} onDelete={deleteTask} onUpdateNotes={updateNotes} onUpdateFields={updateFields} />
      )}
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  lookup,
  onToggle,
  onSetStatus,
  onDelete,
  onUpdateNotes,
  onUpdateFields,
  onAddToCategory,
}: {
  title: string;
  tasks: Task[];
  lookup: ReadonlyMap<string, Task>;
  onToggle: (t: Task) => void;
  onSetStatus: (t: Task, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onUpdateNotes: (t: Task, notes: string) => void;
  onUpdateFields: (t: Task, patch: TaskPatch) => void;
  onAddToCategory?: (title: string) => void;
}) {
  const [inlineTitle, setInlineTitle] = useState('');
  const addInline = () => {
    const t = inlineTitle.trim();
    if (!t || !onAddToCategory) return;
    onAddToCategory(t);
    setInlineTitle('');
  };
  // Sub-tasks sit under their parent when both are in this group; a child
  // whose parent landed elsewhere (a different bucket, or done) stays a
  // row of its own so nothing disappears from a filtered view.
  const renderTree = (node: Nested<Task>, depth: number): React.ReactNode => (
    <div key={node.id} className={depth > 0 ? 'pl-6' : undefined}>
      <TaskRow
        task={node}
        depth={depth}
        waiting={waitingText(node, lookup)}
        subtasks={subtaskProgress(node, [...lookup.values()])}
        onToggle={onToggle}
        onSetStatus={onSetStatus}
        onDelete={onDelete}
        onUpdateNotes={onUpdateNotes}
        onUpdateFields={onUpdateFields}
      />
      {node.children.length > 0 && <div className="mt-1 space-y-1">{node.children.map((c) => renderTree(c, depth + 1))}</div>}
    </div>
  );
  return (
    <div className="space-y-2 stagger">
      <h2 className="section-label">{title}</h2>
      {nestTasks(tasks).map((node) => renderTree(node, 0))}
      {onAddToCategory && (
        <div className="flex gap-2 pl-8">
          <input
            type="text"
            value={inlineTitle}
            onChange={(e) => setInlineTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addInline()}
            placeholder={`Add to ${title.replace(/ \(\d+\)$/, '')}…`}
            className="flex-1 rounded-full border border-outline-variant/15 bg-surface px-3 py-1.5 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
          />
          <button
            onClick={addInline}
            className="px-3 py-1.5 text-xs rounded-full border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high inline-flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      )}
    </div>
  );
}

/** task.dueAt → a `<input type="date">` value (YYYY-MM-DD), or '' if unset. */
function toDateInput(dueAt?: string | null): string {
  if (!dueAt) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(dueAt)) return dueAt.slice(0, 10);
  const ms = dueMs(dueAt);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TaskRow({
  task,
  depth = 0,
  waiting,
  subtasks,
  onToggle,
  onSetStatus,
  onDelete,
  onUpdateNotes,
  onUpdateFields,
}: {
  task: Task;
  depth?: number;
  waiting: string | null;
  subtasks: { done: number; total: number } | null;
  onToggle: (t: Task) => void;
  onSetStatus: (t: Task, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onUpdateNotes: (t: Task, notes: string) => void;
  onUpdateFields: (t: Task, patch: TaskPatch) => void;
}) {
  const due = dueLabel(task.dueAt);
  const [editingNotes, setEditingNotes] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [draft, setDraft] = useState(task.notes ?? '');

  // Keep the draft in sync with external updates (agent edits / refetch) while
  // the editor is closed — without this, reopening could show a stale value.
  // Adjust state during render (the React-endorsed alternative to an effect):
  // reseed whenever the incoming notes change and the editor isn't open.
  const [seededNotes, setSeededNotes] = useState(task.notes ?? '');
  if (!editingNotes && seededNotes !== (task.notes ?? '')) {
    setSeededNotes(task.notes ?? '');
    setDraft(task.notes ?? '');
  }

  const saveNotes = () => {
    setEditingNotes(false);
    if (draft !== (task.notes ?? '')) onUpdateNotes(task, draft);
  };

  return (
    <div className="px-3 py-2.5 rounded-xs border border-outline-variant/10 bg-surface" data-testid="task-row" data-depth={depth}>
      <div className="flex items-center gap-3">
        <button
          onClick={() => onToggle(task)}
          aria-label={task.status === 'done' ? 'Mark open' : 'Mark done'}
          title={task.status === 'in_progress' ? 'In progress — click to mark done' : undefined}
          className={`shrink-0 font-mono text-sm leading-none select-none ${task.status === 'done' ? 'text-tertiary' : task.status === 'in_progress' ? 'text-primary hover:text-tertiary' : 'text-on-surface-variant/70 hover:text-primary'}`}
        >
          {task.status === 'done' ? '[x]' : task.status === 'in_progress' ? '[>]' : '[ ]'}
        </button>
        <div className="min-w-0 flex-1">
          <p className={`text-sm flex items-center gap-1.5 ${task.status === 'done' ? 'line-through text-on-surface-variant' : 'text-on-surface'}`}>
            {depth > 0 && <CornerDownRight className="w-3 h-3 shrink-0 text-on-surface-variant/50" aria-hidden />}
            <span className="min-w-0 truncate">{task.title}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-0.5">
            {task.priority > 0 && (
              <span title={PRIORITY[task.priority]} className={`text-[10px] font-mono font-semibold ${priorityClasses(task.priority)}`}>
                P{task.priority}
              </span>
            )}
            {task.estimate && (
              <span title="estimate" className="text-[10px] font-mono inline-flex items-center gap-0.5 text-on-surface-variant">
                <Ruler className="w-2.5 h-2.5" /> {task.estimate}
              </span>
            )}
            {subtasks && (
              <span title="sub-tasks done" className="text-[10px] font-mono text-on-surface-variant">
                {subtasks.done}/{subtasks.total} sub-tasks
              </span>
            )}
            {waiting && task.status !== 'done' && (
              <span className="text-[10px] inline-flex items-center gap-0.5 text-error/80" title="cannot start yet">
                <Lock className="w-2.5 h-2.5" /> {waiting}
              </span>
            )}
            {task.category && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary/10 text-on-surface-variant inline-flex items-center gap-0.5">
                <Tag className="w-2.5 h-2.5" /> {task.category}
              </span>
            )}
            {due && (
              <span className={`text-[10px] ${due.overdue && task.status !== 'done' ? 'text-error' : 'text-on-surface-variant'}`}>
                due {due.text}
              </span>
            )}
            {task.source !== 'user' && (
              <span className="text-[10px] inline-flex items-center gap-0.5 text-on-surface-variant/70">
                <Sparkles className="w-2.5 h-2.5" /> {task.source}
              </span>
            )}
            {task.reason && task.status !== 'done' && (
              <span className="text-[10px] text-on-surface-variant/70" title="why it ranks here">{task.reason}</span>
            )}
            <button
              onClick={() => { setDraft(task.notes ?? ''); setEditingNotes((v) => !v); }}
              className={`text-[10px] inline-flex items-center gap-0.5 ${task.notes ? 'text-primary' : 'text-on-surface-variant/70'} hover:text-on-surface`}
              title={task.notes ? 'Edit notes' : 'Add notes'}
            >
              <NotebookPen className="w-2.5 h-2.5" /> {task.notes ? 'notes' : 'add notes'}
            </button>
            <button
              onClick={() => setEditingMeta((v) => !v)}
              className="text-[10px] inline-flex items-center gap-0.5 text-on-surface-variant/70 hover:text-on-surface"
              title="Set due date, category, priority"
            >
              <Pencil className="w-2.5 h-2.5" /> edit
            </button>
          </div>
        </div>
        <button
          onClick={() => onDelete(task.id)}
          aria-label="Delete task"
          className="shrink-0 text-on-surface-variant hover:text-error self-start"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Notes — a place to store more about the task (the QA ask). */}
      {editingNotes ? (
        <div className="mt-2 pl-8">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveNotes}
            autoFocus
            rows={3}
            placeholder="Add details, links, context…"
            className="w-full rounded-xs border border-outline-variant/20 bg-surface px-2 py-1.5 text-sm text-on-surface resize-y"
          />
          <div className="flex gap-2 mt-1">
            {/* preventDefault on mousedown keeps focus so the textarea's blur
                doesn't also fire saveNotes (which would double-PATCH). */}
            <button onMouseDown={(e) => e.preventDefault()} onClick={saveNotes} className="text-xs px-2 py-1 rounded bg-primary/10 text-primary">Save</button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setEditingNotes(false)} className="text-xs px-2 py-1 text-on-surface-variant hover:text-on-surface">Cancel</button>
          </div>
        </div>
      ) : task.notes ? (
        <p className="mt-1 pl-8 text-xs text-on-surface-variant whitespace-pre-wrap">{task.notes}</p>
      ) : null}

      {/* Meta editor — set/clear due date, category, priority (the QA: users
          couldn't set due dates and wanted custom categories). */}
      {editingMeta && (
        <div className="mt-2 pl-8 flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-on-surface-variant inline-flex items-center gap-1">
            Due
            <input
              type="date"
              defaultValue={toDateInput(task.dueAt)}
              onChange={(e) => onUpdateFields(task, { dueAt: e.target.value || null })}
              className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
            />
          </label>
          <input
            type="text"
            list="task-categories"
            defaultValue={task.category ?? ''}
            placeholder="Category…"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (task.category ?? '')) onUpdateFields(task, { category: v || null });
            }}
            className="w-32 rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
          />
          <select
            defaultValue={task.priority}
            onChange={(e) => onUpdateFields(task, { priority: Number(e.target.value) })}
            className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
          >
            {PRIORITY.map((label, i) => (
              <option key={label} value={i}>{label}</option>
            ))}
          </select>
          <input
            type="text"
            defaultValue={task.estimate ?? ''}
            placeholder="Estimate (S/M/L, 3h)"
            title="Effort estimate"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (task.estimate ?? '')) onUpdateFields(task, { estimate: v || null });
            }}
            className="w-32 rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
          />
          <select
            value={task.status}
            aria-label="Status"
            onChange={(e) => onSetStatus(task, e.target.value as TaskStatus)}
            className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface"
          >
            {(Object.keys(TASK_STATUS_TITLE) as TaskStatus[]).map((st) => (
              <option key={st} value={st}>{TASK_STATUS_TITLE[st]}</option>
            ))}
          </select>
          <button onClick={() => setEditingMeta(false)} className="text-[11px] px-2 py-1 text-on-surface-variant hover:text-on-surface">Done</button>
        </div>
      )}
    </div>
  );
}

/**
 * The board: one column per status, lanes by category inside each column
 * (a PM's phases are categories, so a plan reads as phase rows across the
 * board). Cards drag between columns with the browser's own drag-and-drop;
 * the arrow buttons do the same move for keyboards and touch.
 */
function TaskBoard({
  tasks,
  lookup,
  onSetStatus,
  onDelete,
}: {
  tasks: Task[];
  lookup: ReadonlyMap<string, Task>;
  onSetStatus: (t: Task, status: TaskStatus) => void;
  onDelete: (id: string) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);

  const lanes = [...new Set(tasks.map((t) => t.category?.trim()).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
  const laneOf = (t: Task) => t.category?.trim() || '';
  const laneKeys = [...lanes, ''];

  const drop = (status: TaskStatus) => {
    const task = dragging ? lookup.get(dragging) : undefined;
    setDragging(null);
    setOver(null);
    if (task) onSetStatus(task, status);
  };

  if (tasks.length === 0) {
    return (
      <div className="py-10 text-center font-mono animate-enter">
        <p aria-hidden className="text-2xl text-on-surface-variant/40">[ ]</p>
        <p className="mt-2 text-sm text-on-surface-variant/70">nothing on the board — add a task above, or ask the project manager for a plan</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="task-board">
      <div className="grid gap-3 min-w-[42rem]" style={{ gridTemplateColumns: `repeat(${BOARD_COLUMNS.length}, minmax(0, 1fr))` }}>
        {BOARD_COLUMNS.map((status, col) => {
          const inColumn = tasks.filter((t) => t.status === status);
          return (
            <section
              key={status}
              aria-label={TASK_STATUS_TITLE[status]}
              data-testid={`board-column-${status}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (over !== status) setOver(status);
              }}
              onDragLeave={() => over === status && setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                drop(status);
              }}
              className={`rounded-xs border p-2 min-h-[12rem] transition-colors ${over === status ? 'border-primary bg-primary/5' : 'border-outline-variant/10 bg-surface-container-low/40'}`}
            >
              <h2 className="section-label mb-2">
                {TASK_STATUS_TITLE[status]} ({inColumn.length})
              </h2>
              <div className="space-y-3">
                {laneKeys.map((lane) => {
                  const cards = inColumn.filter((t) => laneOf(t) === lane);
                  if (cards.length === 0) return null;
                  return (
                    <div key={lane || '__none'} data-testid="board-lane">
                      <p className="text-[10px] uppercase tracking-wide text-on-surface-variant/70 mb-1 inline-flex items-center gap-1">
                        <Tag className="w-2.5 h-2.5" /> {lane || 'Uncategorized'}
                      </p>
                      <div className="space-y-1.5">
                        {cards.map((task) => (
                          <BoardCard
                            key={task.id}
                            task={task}
                            waiting={waitingText(task, lookup)}
                            subtasks={subtaskProgress(task, tasks)}
                            parentTitle={task.parentId ? (lookup.get(task.parentId)?.title ?? null) : null}
                            dragging={dragging === task.id}
                            prev={col > 0 ? BOARD_COLUMNS[col - 1] : null}
                            next={col < BOARD_COLUMNS.length - 1 ? BOARD_COLUMNS[col + 1] : null}
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', task.id);
                              e.dataTransfer.effectAllowed = 'move';
                              setDragging(task.id);
                            }}
                            onDragEnd={() => {
                              setDragging(null);
                              setOver(null);
                            }}
                            onMove={(st) => onSetStatus(task, st)}
                            onDelete={() => onDelete(task.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({
  task,
  waiting,
  subtasks,
  parentTitle,
  dragging,
  prev,
  next,
  onDragStart,
  onDragEnd,
  onMove,
  onDelete,
}: {
  task: Task;
  waiting: string | null;
  subtasks: { done: number; total: number } | null;
  parentTitle: string | null;
  dragging: boolean;
  prev: TaskStatus | null;
  next: TaskStatus | null;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onMove: (status: TaskStatus) => void;
  onDelete: () => void;
}) {
  const due = dueLabel(task.dueAt);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-testid="board-card"
      className={`group rounded-xs border border-outline-variant/15 bg-surface px-2.5 py-2 cursor-grab active:cursor-grabbing ${dragging ? 'opacity-40' : ''}`}
    >
      <p className={`text-sm leading-snug ${task.status === 'done' ? 'line-through text-on-surface-variant' : 'text-on-surface'}`}>{task.title}</p>
      {parentTitle && (
        <p className="text-[10px] text-on-surface-variant/70 inline-flex items-center gap-0.5 mt-0.5">
          <CornerDownRight className="w-2.5 h-2.5" /> {parentTitle}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
        {task.priority > 0 && (
          <span title={PRIORITY[task.priority]} className={`text-[10px] font-mono font-semibold ${priorityClasses(task.priority)}`}>
            P{task.priority}
          </span>
        )}
        {task.estimate && (
          <span title="estimate" className="text-[10px] font-mono inline-flex items-center gap-0.5 text-on-surface-variant">
            <Ruler className="w-2.5 h-2.5" /> {task.estimate}
          </span>
        )}
        {subtasks && (
          <span className="text-[10px] font-mono text-on-surface-variant">
            {subtasks.done}/{subtasks.total}
          </span>
        )}
        {due && (
          <span className={`text-[10px] ${due.overdue && task.status !== 'done' ? 'text-error' : 'text-on-surface-variant'}`}>due {due.text}</span>
        )}
        {task.source !== 'user' && (
          <span className="text-[10px] inline-flex items-center gap-0.5 text-on-surface-variant/70">
            <Sparkles className="w-2.5 h-2.5" /> {task.source}
          </span>
        )}
        {waiting && task.status !== 'done' && (
          <span className="text-[10px] inline-flex items-center gap-0.5 text-error/80" title="cannot start yet">
            <Lock className="w-2.5 h-2.5" /> {waiting}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 mt-1.5 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          onClick={() => prev && onMove(prev)}
          disabled={!prev}
          aria-label={prev ? `Move to ${TASK_STATUS_TITLE[prev]}` : 'Already in the first column'}
          className="text-on-surface-variant hover:text-primary disabled:opacity-30"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => next && onMove(next)}
          disabled={!next}
          aria-label={next ? `Move to ${TASK_STATUS_TITLE[next]}` : 'Already in the last column'}
          className="text-on-surface-variant hover:text-primary disabled:opacity-30"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <span className="flex-1" />
        <button onClick={onDelete} aria-label="Delete task" className="text-on-surface-variant hover:text-error">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
