'use client';

import { ArrowLeft, ArrowRight, CornerDownRight, Lock, Ruler, Sparkles, Tag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AssigneeChip, CommentsThread, CommentsToggle, LeaseBadge, ReleaseClaimButton } from '@/components/tasks/work-board';
import type { Todo } from '@/components/todos/model';
import { dueText } from '@/components/todos/model';
import { TASK_STATUS_TITLE, type TaskStatus, isActiveStatus } from '../../../src/core/tasks/status';
import { waitingOn, waitingReason } from '../../../src/core/tasks/structure';

type Task = Todo;
const PRIORITY = ['none', 'low', 'medium', 'high'] as const;
/** The board's lanes, left to right. Archived stays out of the way, as in the list. */
const BOARD_COLUMNS: readonly TaskStatus[] = ['open', 'in_progress', 'done'];

function priorityClasses(p: number): string {
  if (p >= 3) return 'text-error';
  if (p === 2) return 'text-primary';
  if (p === 1) return 'text-on-surface-variant';
  return 'text-on-surface-variant/60';
}

/** One-line "why can't I start this" for a task, judged against everything on the page. */
export function waitingText(task: Task, lookup: ReadonlyMap<string, Task>): string | null {
  return waitingReason(waitingOn(task, lookup));
}

/**
 * Only what blocks a to-do from elsewhere, for a list row: its open steps
 * already show as "1 of 3", so "2 sub-tasks open" would say it twice.
 */
export function blockedText(task: Task, lookup: ReadonlyMap<string, Task>): string | null {
  const waiting = waitingOn(task, lookup);
  return waiting.blockers.length > 0 ? waitingReason({ ...waiting, openChildren: 0 }) : null;
}

/** Sub-task progress for a parent: done out of all, or null when it has none. */
export function subtaskProgress(task: Task, all: readonly Task[]): { done: number; total: number } | null {
  const kids = all.filter((t) => t.parentId === task.id && t.status !== 'archived');
  if (kids.length === 0) return null;
  return { done: kids.filter((t) => !isActiveStatus(t.status)).length, total: kids.length };
}

function dueLabel(dueAt?: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const d = dueText(dueAt);
  return { text: d.text, overdue: d.tone === 'overdue' };
}

/**
 * The board (the to-do page's second view, used for spaces and agents): one column per status, lanes by category inside each column
 * (a PM's phases are categories, so a plan reads as phase rows across the
 * board). Cards drag between columns with the browser's own drag-and-drop;
 * the arrow buttons do the same move for keyboards and touch.
 */
export function TaskBoard({
  tasks,
  lookup,
  onSetStatus,
  onDelete,
  onRelease,
  onEdit,
  canWrite,
  canComment,
}: {
  tasks: Task[];
  lookup: ReadonlyMap<string, Task>;
  onSetStatus: (t: Task, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onRelease: (t: Task) => void;
  onEdit: (t: Task) => void;
  /** Without it the board is read-only: no drag, no moves, no delete. */
  canWrite: boolean;
  canComment: boolean;
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
        <p className="mt-2 text-sm text-on-surface-variant/70">nothing on the board — add a to-do above, or ask the project manager for a plan</p>
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
                            subtasks={subtaskProgress(task, [...lookup.values()])}
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
                            onRelease={() => onRelease(task)}
                            onEdit={() => onEdit(task)}
                            canWrite={canWrite}
                            canComment={canComment}
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
  onRelease,
  onEdit,
  canWrite,
  canComment,
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
  onRelease: () => void;
  onEdit: () => void;
  canWrite: boolean;
  canComment: boolean;
}) {
  const due = dueLabel(task.dueAt);
  const [showComments, setShowComments] = useState(false);
  // Typing in the comment box: the card must not start a drag when the user
  // selects text there.
  const [typing, setTyping] = useState(false);
  return (
    <div
      draggable={canWrite && !typing}
      onDragStart={canWrite ? onDragStart : undefined}
      onDragEnd={canWrite ? onDragEnd : undefined}
      data-testid="board-card"
      className={`group rounded-xs border border-outline-variant/15 bg-surface px-2.5 py-2 ${canWrite ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging ? 'opacity-40' : ''}`}
    >
      <p className={`text-sm leading-snug ${task.status === 'done' ? 'line-through text-on-surface-variant' : 'text-on-surface'}`}>{task.title}</p>
      {parentTitle && (
        <p className="text-[10px] text-on-surface-variant/70 inline-flex items-center gap-0.5 mt-0.5">
          <CornerDownRight className="w-2.5 h-2.5" /> {parentTitle}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
        <AssigneeChip task={task} />
        <LeaseBadge task={task} />
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
        {canWrite && (
          <>
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
          </>
        )}
        <span className="flex-1" />
        <CommentsToggle open={showComments} onToggle={() => setShowComments((v) => !v)} />
        <button onClick={onEdit} aria-label="Open details" className="text-xs text-primary hover:underline">Open</button>
        {canWrite && <ReleaseClaimButton task={task} onRelease={onRelease} compact />}
        {canWrite && (
          <button onClick={onDelete} aria-label="Delete task" className="text-on-surface-variant hover:text-error">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {showComments && (
        <div onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}>
          <CommentsThread taskId={task.id} indent={false} canComment={canComment} />
        </div>
      )}
    </div>
  );
}
