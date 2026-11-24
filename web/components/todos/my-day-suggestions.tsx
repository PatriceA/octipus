'use client';

import { useQuery } from '@tanstack/react-query';
import { Lightbulb, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { browserTimezone, dueText, type Todo } from './model';

interface MyDayResponse {
  date: string;
  timezone: string;
  tasks: Todo[];
  suggestions: Todo[];
}

/**
 * Suggestions for My Day (GET /api/tasks/my-day): to-dos left in My Day on
 * an earlier day, then the pressing ones of the next-action ranking, each
 * with why. "+" adds one to today. Re-read whenever the list changes
 * (`version`), so an added one leaves the suggestions.
 */
export function MyDaySuggestions({ version, canWrite, onAdd, only, title = 'Suggestions', hideWhenEmpty = false }: {
  version: string;
  canWrite: boolean;
  onAdd: (task: Todo) => void;
  /** Only the to-dos left in My Day on an earlier day ("offered again", the Today page). */
  only?: 'earlier';
  title?: string;
  /** Nothing to suggest: show nothing (rather than say so). */
  hideWhenEmpty?: boolean;
}) {
  const query = useQuery({
    queryKey: ['todos-my-day', version],
    queryFn: () => api.get<MyDayResponse>(`/tasks/my-day?tz=${encodeURIComponent(browserTimezone())}`),
    placeholderData: (previous) => previous,
  });
  // Added here: gone from the list at once, before the re-read.
  const [added, setAdded] = useState<Set<string>>(new Set());
  const data = query.data;
  const error = query.error ? query.error.message : '';
  const load = () => void query.refetch();
  const suggestions = (data?.suggestions ?? []).filter((s) => !added.has(s.id) && (!only || s.bucket === only));
  if (hideWhenEmpty && !error && suggestions.length === 0) return null;
  const addAll = () => {
    setAdded((a) => new Set([...a, ...suggestions.map((s) => s.id)]));
    for (const t of suggestions) onAdd(t);
  };
  return (
    <section aria-label={only ? title : 'Suggestions for My Day'} data-testid={only ? 'my-day-earlier' : 'my-day-suggestions'} className="mt-6">
      <div className="flex items-center gap-2">
        <h2 className="todo-group-title inline-flex flex-1 items-center gap-1.5"><Lightbulb className="h-4 w-4 text-accent" aria-hidden />{title}</h2>
        {only && canWrite && suggestions.length > 1 && <button type="button" className="todo-tool" onClick={addAll}><Plus className="h-4 w-4" />Add all to today</button>}
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-2 px-1 text-sm text-error">
          Suggestions could not be loaded: {error}
          <button type="button" onClick={load} className="todo-tool"><RefreshCw className="h-4 w-4" />Retry</button>
        </p>
      )}
      {!error && data && suggestions.length === 0 && <p className="px-1 text-sm text-on-surface-variant">Nothing pressing. Add to-dos from any list with “Add to My Day”.</p>}
      <div className="todo-list">
        {suggestions.map((t) => (
          <div key={t.id} className="todo-row !cursor-default" data-testid="my-day-suggestion">
            <div className="min-w-0 flex-1 py-2.5 pl-3">
              <p className="todo-title">{t.title}</p>
              <div className="todo-meta">
                <span>{t.reason}</span>
                {t.category && <><span aria-hidden className="todo-meta-dot">·</span><span>{t.category}</span></>}
                {t.dueAt && t.bucket !== 'overdue' && t.bucket !== 'today' && <><span aria-hidden className="todo-meta-dot">·</span><span>{dueText(t.dueAt).text}</span></>}
              </div>
            </div>
            {canWrite && (
              <button type="button" className="todo-star" aria-label={`Add “${t.title}” to My Day`} title="Add to My Day"
                onClick={() => { setAdded((a) => new Set(a).add(t.id)); onAdd(t); }}>
                <Plus className="h-5 w-5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
