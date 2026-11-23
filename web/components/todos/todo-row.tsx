'use client';

import { Bell, CalendarDays, Check, GripVertical, Lock, NotebookPen, Repeat, Star, Sun } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { AssigneeChip } from '@/components/tasks/work-board';
import { cn } from '@/lib/utils';
import { isActiveStatus } from '../../../src/core/tasks/status';
import { dueText, type Todo } from './model';

/** The round checkbox: a real button with a 40px hit area around a 20px ring. */
export function TodoCheck({ task, onToggle, disabled, completing, size = 'md' }: {
  task: Todo;
  onToggle: () => void;
  disabled?: boolean;
  completing?: boolean;
  size?: 'md' | 'sm';
}) {
  const done = task.status === 'done' || completing;
  const label = task.status === 'done' ? 'Mark open' : 'Mark done';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.status === 'done'}
      aria-label={label}
      title={task.status === 'in_progress' ? 'In progress — click to mark done' : undefined}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn('todo-check group/check', size === 'sm' && 'todo-check-sm', done && 'is-done', completing && 'is-completing', task.status === 'in_progress' && 'is-doing')}
    >
      <span className="todo-check-ring" aria-hidden>
        <Check className="todo-check-mark" strokeWidth={3} />
      </span>
    </button>
  );
}

export function StarButton({ important, onToggle, disabled }: { important: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={important}
      aria-label={important ? 'Remove importance' : 'Mark as important'}
      title={important ? 'Remove importance' : 'Mark as important'}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn('todo-star', important && 'is-on')}
    >
      <Star className="h-[18px] w-[18px]" fill={important ? 'currentColor' : 'none'} strokeWidth={1.75} />
    </button>
  );
}

export interface RowContext {
  /** The list being shown, so the row does not repeat it in its meta line. */
  showList: boolean;
  showMyDay: boolean;
  /** Spaces: who it is assigned to. */
  showAssignee: boolean;
  today: string;
}

/** One quiet line under the title: list, My Day, steps, due, reminder, repeat, notes. */
function MetaLine({ id, task, ctx, steps, waiting }: { id: string; task: Todo; ctx: RowContext; steps: { done: number; total: number } | null; waiting: string | null }) {
  const parts: ReactNode[] = [];
  const active = isActiveStatus(task.status);
  if (ctx.showMyDay && task.myDayOn === ctx.today) parts.push(<span key="md" className="inline-flex items-center gap-1"><Sun className="h-3.5 w-3.5" aria-hidden />My Day</span>);
  if (ctx.showList && task.category) parts.push(<span key="list" data-testid="task-list-name">{task.category}</span>);
  if (steps) parts.push(<span key="steps">{steps.done} of {steps.total}</span>);
  if (task.dueAt) {
    const due = dueText(task.dueAt);
    parts.push(
      <span key="due" data-testid="task-due" className={cn('inline-flex items-center gap-1', active && due.tone === 'overdue' && 'text-error', active && due.tone === 'today' && 'text-primary')}>
        <CalendarDays className="h-3.5 w-3.5" aria-hidden />{due.text}
      </span>,
    );
  }
  // Icons carry their meaning as text for screen readers (the row's description reads it).
  if (task.remindAt && active) parts.push(<span key="remind" aria-label="Has a reminder" role="img"><Bell className="h-3.5 w-3.5" aria-hidden /></span>);
  if (task.repeat) parts.push(<span key="repeat" aria-label="Repeats" role="img"><Repeat className="h-3.5 w-3.5" aria-hidden /></span>);
  if (task.notes?.trim()) parts.push(<span key="notes" aria-label="Has notes" role="img"><NotebookPen className="h-3.5 w-3.5" aria-hidden /></span>);
  if (task.important) parts.push(<span key="star" className="sr-only">Important</span>);
  if (waiting && active) parts.push(<span key="wait" className="inline-flex items-center gap-1 text-error/80" title="cannot start yet"><Lock className="h-3 w-3" aria-hidden />{waiting}</span>);
  if (ctx.showAssignee || task.assigneeKind === 'role' || task.assigneeKind === 'node') {
    if (task.assigneeKind && task.assigneeRef) parts.push(<AssigneeChip key="who" task={task} />);
  }
  if (task.source !== 'user' && task.source !== 'agent') parts.push(<span key="src">from {task.source}</span>);
  if (parts.length === 0) return null;
  return (
    <div className="todo-meta" id={id}>
      {parts.map((p, i) => <span key={i} className="inline-flex items-center">{i > 0 && <span aria-hidden className="todo-meta-dot">·</span>}{p}</span>)}
      {task.dueAt && active && dueText(task.dueAt).tone === 'overdue' && <span className="sr-only">, overdue</span>}
    </div>
  );
}

/**
 * A to-do in a list: checkbox, title, one quiet metadata line, star. Click
 * (or Enter) opens it in the detail panel; the row is the drag handle.
 */
export const TodoRow = forwardRef<HTMLDivElement, {
  task: Todo;
  ctx: RowContext;
  steps: { done: number; total: number } | null;
  waiting: string | null;
  selected: boolean;
  completing: boolean;
  canWrite: boolean;
  /** The star is the viewer's own: anyone who can read the to-do may set it. */
  canStar: boolean;
  draggable: boolean;
  dropEdge?: 'before' | 'after' | null;
  onToggle: () => void;
  onToggleImportant: () => void;
  onOpen: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  tabIndex: number;
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
}>(function TodoRow({ task, ctx, steps, waiting, selected, completing, canWrite, canStar, draggable, dropEdge, onToggle, onToggleImportant, onOpen, onKeyDown, onFocus, tabIndex, dragProps }, ref) {
  const done = task.status === 'done';
  // Named by its title and described by its metadata line (due, overdue, My
  // Day, steps, list…), so a screen reader hears both, not the title alone.
  const titleId = `todo-title-${task.id}`;
  const metaId = `todo-meta-${task.id}`;
  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={tabIndex}
      aria-current={selected ? 'true' : undefined}
      aria-labelledby={titleId}
      aria-describedby={done ? `todo-state-${task.id} ${metaId}` : metaId}
      aria-keyshortcuts={draggable ? 'Space Enter Delete Alt+ArrowUp Alt+ArrowDown' : 'Space Enter Delete'}
      data-testid="task-row"
      data-task-id={task.id}
      draggable={draggable}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      {...dragProps}
      className={cn('todo-row group', selected && 'is-selected', done && 'is-done', completing && 'is-completing', dropEdge === 'before' && 'drop-before', dropEdge === 'after' && 'drop-after')}
    >
      {draggable && <GripVertical className="todo-grip" aria-hidden />}
      <TodoCheck task={task} onToggle={onToggle} disabled={!canWrite} completing={completing} />
      <div className="min-w-0 flex-1 py-2.5">
        <p id={titleId} className={cn('todo-title', (done || completing) && 'is-done')}>{task.title}</p>
        {done && <span id={`todo-state-${task.id}`} className="sr-only">Completed</span>}
        <MetaLine id={metaId} task={task} ctx={ctx} steps={steps} waiting={waiting} />
      </div>
      <StarButton important={!!task.important} onToggle={onToggleImportant} disabled={!canStar} />
    </div>
  );
});
