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
function MetaLine({ task, ctx, steps, waiting }: { task: Todo; ctx: RowContext; steps: { done: number; total: number } | null; waiting: string | null }) {
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
  if (task.remindAt && active) parts.push(<Bell key="remind" className="h-3.5 w-3.5" aria-label="Has a reminder" />);
  if (task.repeat) parts.push(<Repeat key="repeat" className="h-3.5 w-3.5" aria-label="Repeats" />);
  if (task.notes?.trim()) parts.push(<NotebookPen key="notes" className="h-3.5 w-3.5" aria-label="Has notes" />);
  if (waiting && active) parts.push(<span key="wait" className="inline-flex items-center gap-1 text-error/80" title="cannot start yet"><Lock className="h-3 w-3" aria-hidden />{waiting}</span>);
  if (ctx.showAssignee || task.assigneeKind === 'role' || task.assigneeKind === 'node') {
    if (task.assigneeKind && task.assigneeRef) parts.push(<AssigneeChip key="who" task={task} />);
  }
  if (task.source !== 'user' && task.source !== 'agent') parts.push(<span key="src">from {task.source}</span>);
  if (parts.length === 0) return null;
  return (
    <div className="todo-meta">
      {parts.map((p, i) => <span key={i} className="inline-flex items-center">{i > 0 && <span aria-hidden className="todo-meta-dot">·</span>}{p}</span>)}
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
  draggable: boolean;
  dropEdge?: 'before' | 'after' | null;
  onToggle: () => void;
  onToggleImportant: () => void;
  onOpen: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  tabIndex: number;
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
}>(function TodoRow({ task, ctx, steps, waiting, selected, completing, canWrite, draggable, dropEdge, onToggle, onToggleImportant, onOpen, onKeyDown, onFocus, tabIndex, dragProps }, ref) {
  const done = task.status === 'done';
  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={tabIndex}
      aria-current={selected ? 'true' : undefined}
      aria-label={task.title}
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
        <p className={cn('todo-title', (done || completing) && 'is-done')}>{task.title}</p>
        <MetaLine task={task} ctx={ctx} steps={steps} waiting={waiting} />
      </div>
      <StarButton important={!!task.important} onToggle={onToggleImportant} disabled={!canWrite} />
    </div>
  );
});
