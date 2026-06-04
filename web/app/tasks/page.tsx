'use client';

import { Check, ListTodo, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
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

function priorityClasses(p: number): string {
  if (p >= 3) return 'bg-error/10 text-error';
  if (p === 2) return 'bg-primary/10 text-primary';
  if (p === 1) return 'bg-surface-container-high text-on-surface-variant';
  return 'bg-surface-container-high text-on-surface-variant/60';
}

function dueLabel(dueAt?: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const overdue = d.getTime() < Date.now();
  return { text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), overdue };
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState(0);

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

  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');

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

      <TaskGroup title={`Open (${open.length})`} tasks={open} onToggle={toggleDone} onDelete={deleteTask} emptyHint="Nothing to do. Add a task above, or ask an agent to remind you." />

      {done.length > 0 && (
        <TaskGroup title={`Done (${done.length})`} tasks={done} onToggle={toggleDone} onDelete={deleteTask} />
      )}
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  onToggle,
  onDelete,
  emptyHint,
}: {
  title: string;
  tasks: Task[];
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
  emptyHint?: string;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-on-surface-variant">{title}</h2>
      {tasks.length === 0 ? (
        emptyHint ? <p className="text-sm text-on-surface-variant/70">{emptyHint}</p> : null
      ) : (
        tasks.map((task) => {
          const due = dueLabel(task.dueAt);
          return (
            <div key={task.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xs border border-outline-variant/10 bg-surface">
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
                </div>
              </div>
              <button
                onClick={() => onDelete(task.id)}
                aria-label="Delete task"
                className="shrink-0 text-on-surface-variant hover:text-error"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
