/**
 * The to-do page's row type and the browser-side formatting it shares between
 * the list, the detail panel, the capture line, the global quick-add and the
 * calendar. List membership and ordering are the shared pure functions of
 * src/core/tasks/smart-lists.ts; this file only formats for this browser.
 */
import type { NextBucket } from '../../../src/core/tasks/rank';
import type { TaskRepeat } from '../../../src/core/tasks/repeat';
import { isAllDayDue } from '../../../src/core/tasks/smart-lists';
import type { TaskStatus } from '../../../src/core/tasks/status';
import type { BoardFields } from '@/components/tasks/work-board';

export interface Todo extends BoardFields {
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
  remindAt?: string | null;
  completedAt?: string | null;
  important?: boolean;
  sortOrder?: number;
  myDayOn?: string | null;
  repeat?: TaskRepeat | null;
  repeatNextId?: string | null;
  source: string;
  createdAt: string;
  updatedAt?: string;
  /** Present on ranked responses (`?view=next`, My Day suggestions). */
  bucket?: NextBucket | 'earlier';
  reason?: string;
}

/** What a PATCH may carry from this page. */
export type TodoPatch = Partial<Pick<Todo,
  'title' | 'notes' | 'status' | 'priority' | 'category' | 'dueAt' | 'remindAt' | 'estimate' | 'assigneeKind' | 'assigneeRef'
  | 'important' | 'sortOrder' | 'repeat' | 'parentId'>> & { myDay?: boolean };

export const PRIORITY_LABEL = ['None', 'Low', 'Medium', 'High'] as const;

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Today's `YYYY-MM-DD` in this browser. */
export function localToday(now: Date = new Date()): string {
  return localDay(now);
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A `YYYY-MM-DD` `n` days from today, in this browser. */
export function dayFromToday(n: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/** Next Monday (a week's start), as MS To Do's "Next week". */
export function nextMonday(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return localDay(d);
}

/**
 * A due date as a row shows it: "Today", "Tomorrow", "Yesterday",
 * "Fri, Nov 27", with the time when there is one; `tone` says how to colour it.
 */
export function dueText(dueAt: string, now: Date = new Date()): { text: string; tone: 'overdue' | 'today' | 'plain' } {
  const due = new Date(dueAt);
  const allDay = isAllDayDue(dueAt);
  const day = localDay(due);
  const today = localToday(now);
  let text: string;
  if (day === today) text = 'Today';
  else if (day === dayFromToday(1, now)) text = 'Tomorrow';
  else if (day === dayFromToday(-1, now)) text = 'Yesterday';
  else text = due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(due.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  if (!allDay) text += ` ${due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const overdue = allDay ? day < today : due.getTime() < now.getTime();
  return { text, tone: overdue ? 'overdue' : day === today ? 'today' : 'plain' };
}

/** A reminder as the detail panel shows it: "Tue, Nov 24, 9:00 AM". */
export function remindText(remindAt: string): string {
  const d = new Date(remindAt);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** `dueAt` → the date input's value (this browser's day), or ''. */
export function dueDateInput(dueAt?: string | null): string {
  return dueAt ? localDay(new Date(dueAt)) : '';
}

/** `dueAt` → the time input's value, or '' for a due day without a time. */
export function dueTimeInput(dueAt?: string | null): string {
  if (!dueAt || isAllDayDue(dueAt)) return '';
  const d = new Date(dueAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The `dueAt` to send for a day and an optional time picked in this browser:
 * a bare day (the server ends it in our zone, sent as `tz`), or the instant.
 */
export function dueValue(day: string, time?: string | null): string {
  if (!time) return day;
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

/** A `datetime-local` value for an instant, in this browser. */
export function localDateTimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** An instant at `time` on `day` (this browser's zone), ISO. */
export function atLocal(day: string, time: string): string {
  return dueValue(day, time);
}
