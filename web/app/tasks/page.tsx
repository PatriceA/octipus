'use client';

import { Check, ListTodo, NotebookPen, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Task {
  id: string;
  title: string;
  notes?: string | null;
  status: 'open' | 'done' | 'archived';
  priority: number;
  dueAt?: string | null;
  completedAt?: string | null;
  source: string;
  createdAt: string;
}

const PRIORITY = ['none', 'low', 'medium', 'high'] as const;
type GroupBy = 'priority' | 'due' | 'none';

function priorityClasses(p: number): string {
  if (p >= 3) return 'bg-error/10 text-error';
  if (p === 2) return 'bg-primary/10 text-primary';
  if (p === 1) return 'bg-surface-container-high text-on-surface-variant';
  return 'bg-surface-container-high text-on-surface-variant/60';
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

  const addTask = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      await api.post('/tasks', { title, priority: newPriority });
      setNewTitle('');
      setNewPriority(0);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xs bg-primary/10 flex items-center justify-center">
          <ListTodo className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-on-surface">To-Do</h1>
          <p className="text-on-surface-variant">Your to-do list. Agents can add, complete, and surface to-do items here.</p>
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Quick add */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          placeholder="Add a task…"
          className="flex-1 rounded-full border border-outline-variant/20 bg-surface px-4 py-2 text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
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
          onClick={addTask}
          className="px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 flex items-center gap-2 font-medium"
        >
          <Plus className="w-4 h-4" /> Add
        </button>
      </div>

      {/* Grouping control */}
      <div className="flex items-center gap-2 text-sm text-on-surface-variant">
        <span>Group by</span>
        {(['priority', 'due', 'none'] as GroupBy[]).map((g) => (
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
        <p className="text-sm text-on-surface-variant/70">Nothing to do. Add a task above, or ask an agent to remind you.</p>
      ) : (
        openGroups.map((g) => (
          <TaskGroup key={g.key} title={g.title} tasks={g.tasks} onToggle={toggleDone} onDelete={deleteTask} onUpdateNotes={updateNotes} />
        ))
      )}

      {done.length > 0 && (
        <TaskGroup title={`Done (${done.length})`} tasks={done} onToggle={toggleDone} onDelete={deleteTask} onUpdateNotes={updateNotes} />
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
}: {
  title: string;
  tasks: Task[];
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
  onUpdateNotes: (t: Task, notes: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">{title}</h2>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} onToggle={onToggle} onDelete={onDelete} onUpdateNotes={onUpdateNotes} />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onDelete,
  onUpdateNotes,
}: {
  task: Task;
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
  onUpdateNotes: (t: Task, notes: string) => void;
}) {
  const due = dueLabel(task.dueAt);
  const [editingNotes, setEditingNotes] = useState(false);
  const [draft, setDraft] = useState(task.notes ?? '');

  // Keep the draft in sync with external updates (agent edits / refetch) while
  // the editor is closed — without this, reopening could show a stale value.
  useEffect(() => {
    if (!editingNotes) setDraft(task.notes ?? '');
  }, [task.notes, editingNotes]);

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
          className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center ${task.status === 'done' ? 'bg-primary border-primary text-on-primary' : 'border-outline-variant/40'}`}
        >
          {task.status === 'done' && <Check className="w-3.5 h-3.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${task.status === 'done' ? 'line-through text-on-surface-variant' : 'text-on-surface'}`}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            {task.priority > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${priorityClasses(task.priority)}`}>
                {PRIORITY[task.priority]}
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
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus the editor the user just opened
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
    </div>
  );
}
