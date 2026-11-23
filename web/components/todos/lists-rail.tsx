'use client';

import { Archive, CalendarDays, CircleCheck, Home, List, Plus, Star, Sun } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { type ListKey, SMART_LIST_TITLE, type SmartList } from '../../../src/core/tasks/smart-lists';

const SMART_ICON: Record<SmartList, typeof Sun> = {
  'my-day': Sun,
  important: Star,
  planned: CalendarDays,
  all: Home,
  completed: CircleCheck,
  archived: Archive,
};

/** What a drop on a rail entry does to the dragged to-do; null = not a target. */
export type RailDrop = (key: ListKey, taskId: string) => void;

/**
 * The lists rail: smart lists, then the user's lists (the `category` values,
 * plus lists made here that have no to-do yet), each with its count of open
 * to-dos. A to-do dragged onto a list moves there; onto My Day, Important or
 * Completed it is added, starred or completed.
 */
export function ListsRail({ smart, counts, lists, current, onSelect, onDrop, onCreateList, canWrite, open, onClose }: {
  smart: readonly SmartList[];
  counts: { smart: Record<SmartList, number>; lists: Map<string, number> };
  lists: readonly string[];
  current: ListKey;
  onSelect: (key: ListKey) => void;
  onDrop: RailDrop;
  onCreateList: (name: string) => void;
  canWrite: boolean;
  /** Phone: the drawer is open. */
  open: boolean;
  onClose: () => void;
}) {
  const [over, setOver] = useState<ListKey | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const droppable = (key: ListKey) => canWrite && (key.startsWith('list:') || key === 'my-day' || key === 'important' || key === 'completed');
  const item = (key: ListKey, label: string, Icon: typeof Sun, count: number | null) => (
    <button
      key={key}
      type="button"
      aria-current={current === key ? 'page' : undefined}
      data-testid={`todo-list-${key}`}
      onClick={() => onSelect(key)}
      onDragOver={(e) => {
        if (!droppable(key) || !e.dataTransfer.types.includes('application/x-octipus-todo')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (over !== key) setOver(key);
      }}
      onDragLeave={() => over === key && setOver(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-octipus-todo');
        setOver(null);
        if (!id || !droppable(key)) return;
        e.preventDefault();
        onDrop(key, id);
      }}
      className={cn('todo-rail-item', over === key && 'is-drop')}
    >
      <Icon aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== null && count > 0 && <span className="todo-rail-count" aria-label={`${count} open`}>{count}</span>}
    </button>
  );
  const create = () => {
    const n = name.trim();
    setNaming(false);
    setName('');
    if (n) onCreateList(n);
  };
  return (
    <>
      <div className={cn('todo-rail-backdrop', open && 'is-open')} onClick={onClose} aria-hidden />
      <nav aria-label="Lists" className={cn('todo-rail', open && 'is-open')}>
        <div className="todo-rail-scroll">
          {smart.map((key) => item(key, SMART_LIST_TITLE[key], SMART_ICON[key], key === 'completed' || key === 'archived' ? null : counts.smart[key]))}
          <div className="todo-rail-sep" />
          {lists.map((l) => item(`list:${l}`, l, List, counts.lists.get(l) ?? 0))}
          {canWrite && (naming ? (
            <div className="px-2 py-1">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                  if (e.key === 'Escape') { setNaming(false); setName(''); }
                }}
                onBlur={create}
                maxLength={100}
                aria-label="New list name"
                placeholder="List name"
                className="todo-field w-full"
              />
            </div>
          ) : (
            <button type="button" onClick={() => setNaming(true)} className="todo-rail-item is-action">
              <Plus aria-hidden />
              <span>New list</span>
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
