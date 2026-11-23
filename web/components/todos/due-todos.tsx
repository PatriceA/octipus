'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListTodo } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useWorkspaceId } from '@/lib/workspace-context';
import { isAllDayDue } from '../../../src/core/tasks/smart-lists';
import { dueText, localDay, localToday, type Todo } from './model';
import { TodoCheck } from './todo-row';

/**
 * The to-dos due on the days a calendar view shows (and, when today is
 * shown, the overdue ones), above the grid: tick one off, or open it on the
 * to-do page. Read from the active to-dos (`GET /api/tasks?doneLimit=0`).
 */
export function DueTodos({ days }: { days: readonly string[] }) {
  const workspace = useWorkspaceId();
  const client = useQueryClient();
  const [error, setError] = useState('');
  const key = ['todos-due', workspace] as const;
  const todos = useQuery({ queryKey: key, queryFn: () => api.get<{ tasks: Todo[] }>('/tasks?doneLimit=0'), staleTime: 30_000 });
  if (todos.error) return <p role="status" className="mb-3 text-xs text-on-surface-variant">To-dos due could not be loaded: {todos.error.message}</p>;
  if (days.length === 0 || !todos.data) return null;
  const first = days[0];
  const last = days[days.length - 1];
  const today = localToday();
  const withTodayOverdue = first <= today && today <= last;
  const due = (todos.data.tasks ?? [])
    .filter((t) => t.dueAt && (t.status === 'open' || t.status === 'in_progress'))
    .map((t) => ({ task: t, day: localDay(new Date(t.dueAt as string)) }))
    .filter(({ day }) => (day >= first && day <= last) || (withTodayOverdue && day < today))
    .sort((a, b) => Date.parse(a.task.dueAt as string) - Date.parse(b.task.dueAt as string));
  if (due.length === 0) return null;
  const complete = async (task: Todo) => {
    client.setQueryData<{ tasks: Todo[] }>(key, (old) => (old ? { ...old, tasks: old.tasks.filter((t) => t.id !== task.id) } : old));
    try {
      await api.patch(`/tasks/${task.id}`, { status: 'done' });
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
    void client.invalidateQueries({ queryKey: key });
  };
  return (
    <section aria-label="To-dos due" data-testid="calendar-due-todos" className="mb-3 rounded-lg border border-outline-variant bg-surface-container px-2 py-1.5">
      <div className="flex items-center gap-2 px-2 pt-1 text-xs font-semibold text-on-surface-variant">
        <ListTodo className="h-4 w-4 text-primary" aria-hidden />
        To-dos due
        <Link href="/tasks?list=planned" className="ml-auto font-medium text-primary hover:underline">All planned</Link>
      </div>
      <ul className="flex flex-wrap gap-x-1 gap-y-0.5">
        {due.map(({ task, day }) => {
          const overdue = dueText(task.dueAt as string).tone === 'overdue';
          const when = `${new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}${isAllDayDue(task.dueAt as string) ? '' : ` ${new Date(task.dueAt as string).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}`;
          return (
            <li key={task.id} className="flex min-w-0 items-center rounded-md pr-2 hover:bg-surface-container-high" data-testid="calendar-due-todo">
              <TodoCheck task={task} size="sm" onToggle={() => void complete(task)} />
              <Link href={`/tasks?list=planned&task=${task.id}`} className="min-w-0 truncate text-sm text-on-surface hover:underline">{task.title}</Link>
              <span className={`ml-2 shrink-0 text-xs ${overdue ? 'text-error' : 'text-on-surface-variant'}`}>{when}</span>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="px-2 pb-1 text-xs text-error">{error}</p>}
    </section>
  );
}
