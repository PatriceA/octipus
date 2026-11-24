/**
 * To-dos linked to notes (to-dos + notes, step 4; docs/API.md "Note ↔ to-do
 * links"). A link is a note attached to a to-do, or the note line the to-do
 * was made from (`task_note_links.anchor`, the line's ` ^todo-<anchor>`).
 *
 * Scope. Both ends are in one scope: a user's personal to-dos and notes, or
 * one space's. A link is made only through `contentRepos(principal)` with
 * both ends reached there (and, personally, both the caller's own), and is
 * read only through the reader's scope on each side: `linkedNotesOf` names
 * a note only when the reader's note store returns it (a guest's folders
 * included), `linkedTasksOf` a to-do only when their task repo does. So a
 * link never shows a note's title or text, or a to-do, to someone who cannot
 * open it. Federation reads (host-ops `task.list` / `task.read`) return the
 * raw rows and carry no links at all.
 *
 * The tick of a line and the to-do's status follow each other, edge for
 * edge, never state for state:
 *   - a to-do moved between done and not done ticks or unticks its lines
 *     (`syncNoteLines`, from `TaskRepo.update`), written like any writer's
 *     change: a personal note only over the text it read (`ifSha256`, read
 *     again on a race), a space note merged into its live text;
 *   - a save of a note whose anchored line's tick changed completes or
 *     reopens that to-do (`reconcileNoteTasks`, from `NoteService.save` and
 *     the live note's refresh); a marker that only appears or disappears
 *     changes nothing.
 * Each side writes only when the other differs, so the two never loop. A
 * to-do that is archived (deleted) is never brought back by a tick, and
 * archiving one leaves its line as it is. A line deleted from the note
 * leaves the to-do and its link (the line comes back with an undo); an
 * edited line keeps its link (the to-do keeps its own title). A repeating
 * to-do's line stays with its occurrence (ticked when it is done); the next
 * occurrence has the note attached (db/repositories/task-series.ts).
 */
import { StaleWriteError } from '@/core/docs/hub';
import { getNoteService } from '@/core/knowledge/notes';
import { auditTaskMutation } from '@/core/tasks/audit';
import { isActiveStatus } from '@/core/tasks/status';
import { type ContentRepos, contentRepos } from '@/db/repositories/content';
import { type NoteScope, personalNoteScope } from '@/db/repositories/note-repository';
import { memberPrincipal } from '@/db/repositories/space';
import { anchoredLinksOfNote, clearAnchors, deleteLink, linksOfNote, linksOfTasks, putLink } from '@/db/repositories/task-note-links';
import type { Note } from '@/db/schema/notes';
import type { Task } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import {
  anchorLine, changedAnchors, type LinkedNote, type LinkedTask as SharedLinkedTask, newTodoAnchor, noteTaskLines, setAnchoredChecked, TODO_ANCHOR,
  todoTitleFromLine,
} from '../../shared/note-todos';

const logger = coreLogger.child({ component: 'task-note-links' });

export type { LinkedNote } from '../../shared/note-todos';
/** A to-do as a note shows it (`linkedTasks`). */
export type LinkedTask = SharedLinkedTask<Date>;

export class NoteLinkError extends Error {
  constructor(readonly code: 'not_found' | 'anchor_taken' | 'other_anchor' | 'invalid', message: string) {
    super(message);
    this.name = 'NoteLinkError';
  }
}

/** Both ends in the scope of `repos` (see the file comment): the same user personally, the same space in one. */
function sameScope(repos: ContentRepos, task: Task, note: Note): boolean {
  if (repos.kind === 'space') return task.workspaceId === repos.workspaceId && note.workspaceId === repos.workspaceId;
  return task.userId === repos.principal.userId && note.userId === repos.principal.userId;
}

function linkedNote(note: Note, anchor: string | null): LinkedNote {
  return { id: note.id, title: note.title, slug: note.slug, noteKind: note.noteKind, noteDate: note.noteDate, archived: !!note.archivedAt, anchor };
}

/** The notes of these to-dos the reader can open, by to-do id (oldest link first). */
export async function linkedNotesOf(repos: ContentRepos, taskIds: readonly string[]): Promise<Map<string, LinkedNote[]>> {
  const out = new Map<string, LinkedNote[]>();
  const links = await linksOfTasks(taskIds);
  if (links.length === 0) return out;
  const notes = new Map((await repos.notes.getByIds([...new Set(links.map((l) => l.noteId))])).map((n) => [n.id, n]));
  for (const link of [...links].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const note = notes.get(link.noteId);
    if (!note) continue;
    out.set(link.taskId, [...(out.get(link.taskId) ?? []), linkedNote(note, link.anchor)]);
  }
  return out;
}

/** `rows` with `linkedNotes` (the notes the reader can open; empty when none). */
export async function withLinkedNotes<T extends { id: string }>(repos: ContentRepos, rows: T[]): Promise<(T & { linkedNotes: LinkedNote[] })[]> {
  const byTask = await linkedNotesOf(repos, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, linkedNotes: byTask.get(r.id) ?? [] }));
}

/** The to-dos of a note the reader can open (oldest link first). */
export async function linkedTasksOf(repos: ContentRepos, noteId: string): Promise<LinkedTask[]> {
  const links = await linksOfNote(noteId);
  if (links.length === 0) return [];
  const tasks = new Map((await repos.tasks.findByIds(links.map((l) => l.taskId))).map((t) => [t.id, t]));
  return [...links]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .flatMap((link) => {
      const task = tasks.get(link.taskId);
      return task ? [{
        id: task.id, title: task.title, status: task.status, dueAt: task.dueAt, completedAt: task.completedAt,
        repeating: !!task.repeat, anchor: link.anchor,
      }] : [];
    });
}

/**
 * Link a note to a to-do (idempotent), as an attachment or, with `anchor`,
 * as the line the to-do was made from. Needs write access to the to-do;
 * either end out of reach is `not_found` (no enumeration).
 */
export async function linkNote(repos: ContentRepos, input: { taskId: string; noteId: string; anchor?: string | null }): Promise<LinkedNote> {
  repos.can('write');
  if (input.anchor != null && !TODO_ANCHOR.test(input.anchor)) throw new NoteLinkError('invalid', 'noteAnchor must be 6 to 16 lowercase letters or digits');
  const [task, note] = await Promise.all([repos.tasks.findById(input.taskId), repos.notes.getById(input.noteId)]);
  if (!task || !note || !sameScope(repos, task, note)) throw new NoteLinkError('not_found', !task ? 'Task not found' : 'Note not found');
  const result = await putLink({ taskId: task.id, noteId: note.id, anchor: input.anchor ?? null, createdBy: repos.principal.userId });
  if (!result.ok) {
    throw result.reason === 'anchor_taken'
      ? new NoteLinkError('anchor_taken', 'That line of the note is already another to-do')
      : new NoteLinkError('other_anchor', 'This to-do is already made from another line of that note');
  }
  return linkedNote(note, result.link.anchor);
}

/** Unlink a note from a to-do (the note and its line stay as they are). False when there was no such link in reach. */
export async function unlinkNote(repos: ContentRepos, taskId: string, noteId: string): Promise<boolean> {
  repos.can('write');
  const task = await repos.tasks.findById(taskId);
  if (!task) return false;
  return deleteLink(task.id, noteId);
}

/** A personal principal of `userId` across their personal workspaces (the note side's own rule). */
function ownerPrincipal(userId: string): Principal {
  return { kind: 'user', userId, username: userId, isAdmin: false, sessionToken: null, roles: ['user'], workspaceId: null, workspaceKind: 'personal' };
}

/**
 * Write a change of a note's body as `userId` would: a space note merged
 * into its current (live) text, a personal note only over the text read
 * (read again when another write came first). `change` gets the body as it
 * is and returns the new one, or null for nothing to write. Returns whether
 * it wrote.
 */
export async function writeNoteBody(scope: NoteScope, noteId: string, userId: string, change: (body: string) => string | null): Promise<boolean> {
  const notes = getNoteService();
  for (let attempt = 0; ; attempt++) {
    const note = await notes.getById(scope, noteId);
    if (!note) return false;
    const next = change(note.body);
    if (next === null || next === note.body) return false;
    try {
      if (scope.kind === 'space') {
        await notes.writeSpaceBody(scope, noteId, { base: { sha256: note.bodySha256, text: note.body }, next, origin: { kind: 'external', userId } });
      } else {
        await notes.save({
          scope, id: noteId, title: note.title, body: next, tags: note.tags, ifSha256: note.bodySha256,
          // This write is the to-do side's: its own lines need no reconcile.
          skipTaskSync: true, deferIndex: true,
        });
      }
      return true;
    } catch (err) {
      if (err instanceof StaleWriteError && attempt < 2) continue;
      throw err;
    }
  }
}

/**
 * A to-do moved between done (`checked`) and not done: tick or untick the
 * note lines it was made from, as `principal` (who changed the to-do).
 * Never throws: a line that could not be written is logged and stays as it
 * was (the to-do's change stands; the next tick of either side writes again).
 */
export async function syncNoteLines(principal: Principal, task: Task, checked: boolean): Promise<void> {
  try {
    const links = (await linksOfTasks([task.id])).filter((l) => l.anchor);
    if (links.length === 0) return;
    const repos = contentRepos(principal);
    // A personal to-do's notes are its owner's (made so); a space's, the space's.
    const scope = repos.kind === 'space' ? repos.noteScope : personalNoteScope(task.userId);
    for (const link of links) {
      const anchor = link.anchor as string;
      try {
        await writeNoteBody(scope, link.noteId, principal.userId, (body) => setAnchoredChecked(body, anchor, checked));
      } catch (err) {
        logger.warn({ err, taskId: task.id, noteId: link.noteId }, 'A linked note line could not follow its to-do; it is left as it was');
      }
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'The note lines of a to-do were not synced');
  }
}

/**
 * A note was saved from `before` to `after` (by `scope.userId`): complete or
 * reopen the to-dos of the anchored lines whose tick changed, as that member.
 * Never throws (the note's save stands; logged).
 */
export async function reconcileNoteTasks(scope: NoteScope, noteId: string, before: string, after: string): Promise<void> {
  const changed = changedAnchors(before, after);
  if (changed.length === 0) return;
  try {
    const links = await anchoredLinksOfNote(noteId, changed.map((c) => c.anchor));
    if (links.length === 0) return;
    const principal = scope.kind === 'space' ? await memberPrincipal(scope.userId, scope.workspaceId) : ownerPrincipal(scope.userId);
    const repos = contentRepos(principal);
    const want = new Map(changed.map((c) => [c.anchor, c.checked]));
    for (const link of links) {
      const checked = want.get(link.anchor as string);
      const task = await repos.tasks.findById(link.taskId);
      // A deleted (archived) to-do is not brought back by a tick.
      if (checked === undefined || !task || task.status === 'archived') continue;
      if (checked ? task.status === 'done' : isActiveStatus(task.status)) continue;
      try {
        const patch = checked ? { status: 'done', completedAt: new Date() } : { status: 'open', completedAt: null };
        const updated = await repos.tasks.update(task.id, patch);
        if (!updated) continue;
        await auditTaskMutation({
          userId: task.userId, taskId: task.id, op: checked ? 'complete' : 'update', change: ['status'],
          actor: { kind: 'user', id: scope.userId }, runId: null,
        });
      } catch (err) {
        logger.warn({ err, taskId: task.id, noteId }, 'A to-do did not follow its note line');
      }
    }
  } catch (err) {
    logger.warn({ err, noteId }, 'The to-dos of a note were not reconciled with its lines');
  }
}

export interface FromNoteResult {
  tasks: Task[];
  /** Whether the lines were marked in the note (false: linked as attachments only). */
  marked: boolean;
  /** Why the lines were not marked, when they were not. */
  reason?: string;
}

/**
 * Make to-dos of a note's task lines that are not to-dos yet: the unticked
 * ones, or the 0-based `lines` given (ticked ones there become done
 * to-dos). Each line is marked in the note and linked. With `markLines`
 * false (an agent whose note changes are proposals) the to-dos are made and
 * the note attached, but its text is not changed.
 */
export async function makeTodosFromNote(
  repos: ContentRepos,
  noteId: string,
  opts: { lines?: number[]; markLines?: boolean; source?: string; sourceRef?: Task['sourceRef'] } = {},
): Promise<FromNoteResult> {
  repos.can('write');
  const note = await getNoteService().getById(repos.noteScope, noteId);
  if (!note) throw new NoteLinkError('not_found', 'Note not found');
  const wanted = opts.lines ? new Set(opts.lines) : null;
  const lines = noteTaskLines(note.body).filter((l) => !l.anchor && (wanted ? wanted.has(l.line) : !l.checked));
  const made: Array<{ task: Task; line: number; anchor: string }> = [];
  for (const line of lines) {
    const title = todoTitleFromLine(line.text);
    if (!title) continue;
    const task = await repos.tasks.create({
      title,
      status: line.checked ? 'done' : 'open',
      completedAt: line.checked ? new Date() : null,
      source: opts.source ?? 'user',
      sourceRef: opts.sourceRef,
    });
    made.push({ task, line: line.line, anchor: newTodoAnchor() });
  }
  if (made.length === 0) return { tasks: [], marked: true };
  const markLines = opts.markLines ?? true;
  for (const m of made) await putLink({ taskId: m.task.id, noteId: note.id, anchor: markLines ? m.anchor : null, createdBy: repos.principal.userId });
  if (!markLines) return { tasks: made.map((m) => m.task), marked: false, reason: 'the note takes changes as proposals here' };
  try {
    // Each line found again in the text as it is now (by its text: lines may have moved).
    const wrote = await writeNoteBody(repos.noteScope, note.id, repos.principal.userId, (body) => {
      let next = body;
      const current = noteTaskLines(body);
      for (const m of made) {
        const seen = lines.find((l) => l.line === m.line);
        const at = current.find((l) => l.line === m.line && !l.anchor && l.text === seen?.text)
          ?? current.find((l) => !l.anchor && l.text === seen?.text);
        if (at) next = anchorLine(next, at.line, m.anchor) ?? next;
      }
      return next;
    });
    if (!wrote) throw new Error('the note changed and the lines were not found');
    return { tasks: made.map((m) => m.task), marked: true };
  } catch (err) {
    logger.warn({ err, noteId }, 'To-dos made from a note: its lines could not be marked; linked as attachments');
    await clearAnchors(note.id, made.map((m) => m.task.id));
    return { tasks: made.map((m) => m.task), marked: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
