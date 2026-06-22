'use client';

import { NotebookPen, Pencil, Plus, RefreshCw, Sparkles, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';

interface Task {
  id: string;
  title: string;
  notes?: string | null;
  status: 'open' | 'done' | 'archived';
  priority: number;
  category?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  source: string;
  createdAt: string;
}

const PRIORITY = ['none', 'low', 'medium', 'high'] as const;
type GroupBy = 'priority' | 'due' | 'category' | 'none';

/** Patchable fields a row can edit inline (besides notes/status). */
type TaskPatch = Partial<Pick<Task, 'priority' | 'category' | 'dueAt'>>;

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
  const [groupBy, setGroupBy] = useState<GroupBy>('priority');

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.get<{ tasks: Task[] }>('/tasks');
      setTasks(data.tasks || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

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
      await api.patch(`/tasks/${task.id}`, patch);
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleDone = async (task: Task) => {
    try {
      await api.patch(`/tasks/${task.id}`, { status: task.status === 'done' ? 'open' : 'done' });
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

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

  const openTasks = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const openGroups = groupOpenTasks(openTasks, groupBy);
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

      {/* Grouping control */}
      <div className="flex items-center gap-2 text-sm text-on-surface-variant">
        <span>Group by</span>
        {(['priority', 'due', 'category', 'none'] as GroupBy[]).map((g) => (
          <button
            key={g}
            onClick={() => setGroupBy(g)}
            className={`px-2.5 py-1 rounded-full text-xs capitalize ${groupBy === g ? 'bg-primary/10 text-primary' : 'hover:bg-surface-container-high'}`}
          >
            {g === 'none' ? 'nothing' : g}
          </button>
        ))}
      </div>

      {openTasks.length === 0 ? (
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
            onToggle={toggleDone}
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

      {done.length > 0 && (
        <TaskGroup title={`Done (${done.length})`} tasks={done} onToggle={toggleDone} onDelete={deleteTask} onUpdateNotes={updateNotes} onUpdateFields={updateFields} />
      )}
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  onToggle,
  onDelete,
  onUpdateNotes,
  onUpdateFields,
  onAddToCategory,
}: {
  title: string;
  tasks: Task[];
  onToggle: (t: Task) => void;
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
  return (
    <div className="space-y-2 stagger">
      <h2 className="section-label">{title}</h2>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} onToggle={onToggle} onDelete={onDelete} onUpdateNotes={onUpdateNotes} onUpdateFields={onUpdateFields} />
      ))}
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
  onToggle,
  onDelete,
  onUpdateNotes,
  onUpdateFields,
}: {
  task: Task;
  onToggle: (t: Task) => void;
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
    <div className="px-3 py-2.5 rounded-xs border border-outline-variant/10 bg-surface">
      <div className="flex items-center gap-3">
        <button
          onClick={() => onToggle(task)}
          aria-label={task.status === 'done' ? 'Mark open' : 'Mark done'}
          className={`shrink-0 font-mono text-sm leading-none select-none ${task.status === 'done' ? 'text-tertiary' : 'text-on-surface-variant/70 hover:text-primary'}`}
        >
          {task.status === 'done' ? '[x]' : '[ ]'}
        </button>
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${task.status === 'done' ? 'line-through text-on-surface-variant' : 'text-on-surface'}`}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            {task.priority > 0 && (
              <span title={PRIORITY[task.priority]} className={`text-[10px] font-mono font-semibold ${priorityClasses(task.priority)}`}>
                P{task.priority}
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
          <button onClick={() => setEditingMeta(false)} className="text-[11px] px-2 py-1 text-on-surface-variant hover:text-on-surface">Done</button>
        </div>
      )}
    </div>
  );
}
