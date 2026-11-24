'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useGatewayMessages } from '@/lib/gateway-context';
import { browserTimezone, type Todo } from '@/components/todos/model';
import { api } from '@/lib/api';
import {
  anchorLine, type LinkedTask, lineAt, newTodoAnchor, noteTaskLines, TODO_MARKER_TAIL, todoTitleFromLine,
} from '../../../src/shared/note-todos';
import type { NoteDraft } from './use-note-draft';

/** What "make a to-do" was asked of: a line (the editor's caret, a line's button), an item's offset (the reading view), or a selection. */
export type MakeTodoTarget = { line: number; selection?: string } | { offset: number } | { selection: string };

/**
 * The open note's to-dos, for any page that shows `NoteEditor`: the chips of
 * its lines made to-dos, "make a to-do" of a line or a selection, and the
 * to-do side of a tick made here.
 *
 *   • A task line becomes a to-do linked to it: the to-do is created first
 *     (`POST /tasks` with `noteId` and a new `noteAnchor`), then the marker
 *     is written into the line the way typing would (`draft.editBody`: the
 *     draft, which saves itself, or the live document). A ticked line makes
 *     a done to-do; a list item or a plain line becomes a task line.
 *   • A selection that is not one task line makes a to-do titled by it, with
 *     the note attached (no line to tick).
 *   • A tick of a linked line: a personal note's save carries it to the
 *     to-do (the server reconciles); a space note's live text is saved by
 *     the hub later, so the to-do is completed here at once.
 */
export function useNoteTodos({ noteId, draft, isSpace, canWrite, onError, onOpenTask, onMade, showUndo, defaults }: {
  noteId: string | null;
  draft: NoteDraft;
  isSpace: boolean;
  canWrite: boolean;
  onError: (message: string) => void;
  onOpenTask: (taskId: string) => void;
  /** A to-do was made or changed here (lists showing to-dos read again). */
  onMade?: () => void;
  showUndo?: (message: string, undo: () => void) => void;
  /** Fields every to-do made here gets (the Today page puts them in My Day). */
  defaults?: { myDay?: boolean };
}) {
  const qc = useQueryClient();
  const detail = draft.detail.data;
  const linked: LinkedTask[] = useMemo(() => (detail && detail.id === noteId ? detail.linkedTasks ?? [] : []), [detail, noteId]);
  const byAnchor = useMemo(() => new Map(linked.filter((t) => t.anchor).map((t) => [t.anchor as string, t])), [linked]);
  const version = useMemo(() => linked.map((t) => `${t.id}:${t.status}:${t.anchor ?? ''}:${t.title}`).join('|'), [linked]);
  const busy = useRef(false);

  // A linked to-do changed elsewhere (the to-do list, an agent, another
  // device): the note reads again (its chips, and its text when the server
  // ticked a line; a draft with unsaved changes keeps them and merges).
  const changedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (changedTimer.current) clearTimeout(changedTimer.current); }, []);
  useGatewayMessages((message) => {
    if (message.type !== 'event' || !noteId || linked.length === 0) return;
    if (message.event.type !== 'tasks.changed' && message.event.type !== 'task.changed') return;
    // Only a change of one of this note's to-dos: every other to-do of the workspace leaves the note alone.
    const taskId = (message.event.payload as { taskId?: string } | undefined)?.taskId;
    if (!taskId || !linked.some((t) => t.id === taskId)) return;
    if (changedTimer.current) clearTimeout(changedTimer.current);
    changedTimer.current = setTimeout(() => { void qc.invalidateQueries({ queryKey: ['note', noteId] }); }, 500);
  });

  const refresh = useCallback((id: string | null) => {
    if (id) void qc.invalidateQueries({ queryKey: ['note', id] });
    onMade?.();
  }, [qc, onMade]);

  const of = useCallback((anchor: string) => {
    const t = byAnchor.get(anchor);
    return t ? { title: t.title, status: t.status } : null;
  }, [byAnchor]);

  const open = useCallback((anchor: string) => {
    const t = byAnchor.get(anchor);
    if (t) onOpenTask(t.id);
  }, [byAnchor, onOpenTask]);

  /** Mark or unmark a task in the text: the marker added to (or taken off) the line that reads `lineText`. */
  const editLine = useCallback((lineNo: number, lineText: string, edit: (body: string, line: number) => string | null): boolean => {
    return draft.editBody((body) => {
      const lines = body.split('\n');
      const at = lines[lineNo] === lineText ? lineNo : lines.indexOf(lineText) === lines.lastIndexOf(lineText) ? lines.indexOf(lineText) : -1;
      return at < 0 ? null : edit(body, at);
    });
  }, [draft]);

  const make = useCallback(async (target: MakeTodoTarget) => {
    if (busy.current) return;
    busy.current = true;
    try {
      // A new note is saved first: a to-do links to a note that exists.
      let id = noteId ?? draft.currentId();
      if (!id) {
        if (!(await draft.flush())) { onError('Save the note first (give it a first line), then make a to-do of it'); return; }
        id = draft.currentId();
      }
      if (!id) return;
      const body = draft.draft.body;
      const lineNo = 'offset' in target ? lineAt(body, target.offset) : 'line' in target ? target.line : null;
      const selection = 'selection' in target ? target.selection?.trim() : undefined;
      const lineText = lineNo !== null ? body.split('\n')[lineNo] ?? '' : '';
      const task = lineNo !== null ? noteTaskLines(body).find((l) => l.line === lineNo) : undefined;
      // A selection inside one line is that line; any other selection is a to-do of its own, the note attached.
      if (selection && !(lineNo !== null && !selection.includes('\n') && lineText.includes(selection) && (task || selection === lineText.trim()))) {
        const title = todoTitleFromLine(selection);
        if (!title) { onError('Select some text to make a to-do of it'); return; }
        const made = await api.post<Todo>('/tasks', { ...defaults, title, noteId: id, tz: browserTimezone() });
        refresh(id);
        showUndo?.(`Made a to-do “${made.title}”`, () => { void api.patch(`/tasks/${made.id}`, { status: 'archived' }).then(() => refresh(id), (err: unknown) => onError(String(err))); });
        return;
      }
      if (lineNo === null) return;
      if (task?.anchor) { open(task.anchor); return; }
      const anchor = newTodoAnchor();
      const title = todoTitleFromLine(lineText);
      if (!title || anchorLine(body, lineNo, anchor) === null) { onError('This line cannot be a to-do (it is empty, a heading or code)'); return; }
      if (!draft.canEditBody) { onError('The note is still opening; try again in a moment'); return; }
      const made = await api.post<Todo>('/tasks', { ...defaults, title, noteId: id, noteAnchor: anchor, tz: browserTimezone() });
      if (task?.checked) await api.patch(`/tasks/${made.id}`, { status: 'done' });
      if (!editLine(lineNo, lineText, (b, at) => anchorLine(b, at, anchor))) {
        onError('The to-do was made, but its line changed meanwhile and was not marked');
      }
      refresh(id);
      showUndo?.(`Made a to-do “${made.title}”`, () => {
        // The marker comes off its line (wherever it is now); the to-do is deleted.
        draft.editBody((b) => {
          const lines = b.split('\n');
          const at = lines.findIndex((l) => TODO_MARKER_TAIL.exec(l)?.[1] === anchor);
          if (at < 0) return null;
          lines[at] = lines[at].replace(TODO_MARKER_TAIL, '');
          return lines.join('\n');
        });
        void api.patch(`/tasks/${made.id}`, { status: 'archived' }).then(() => refresh(id), (err: unknown) => onError(String(err)));
      });
    } catch (err) {
      onError(`Could not make the to-do: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.current = false;
    }
  }, [noteId, draft, onError, refresh, open, editLine, showUndo, defaults]);

  /**
   * A linked line's box was ticked here (the editor, the reading view). The
   * server carries the tick to the to-do — a personal note's save, a live
   * note's update as it reaches the hub — as the member who made it, in
   * order: nothing is sent from here (two writers would race). The chips
   * follow on the `tasks.changed` / `task.changed` that change sends.
   */
  const toggled = useCallback((_anchor: string, _checked: boolean) => undefined, []);

  /** Complete or reopen a linked to-do from the note's side (its context panel); its line follows on the server. */
  const setDone = useCallback(async (task: LinkedTask, done: boolean) => {
    // An unsaved edit goes first, so the tick reaches the text the server has.
    if (!isSpace) await draft.flush();
    try {
      await api.patch(`/tasks/${task.id}`, { status: done ? 'done' : 'open' });
    } catch (err) {
      onError(`Could not update the to-do: ${err instanceof Error ? err.message : String(err)}`);
    }
    refresh(noteId);
  }, [draft, isSpace, noteId, onError, refresh]);

  return { linked, of, open, version, make: canWrite ? make : undefined, toggled, setDone };
}

export type NoteTodos = ReturnType<typeof useNoteTodos>;
