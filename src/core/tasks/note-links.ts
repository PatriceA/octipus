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
 * The tick of a line and the to-do's status follow each other, change for
 * change:
 *   - a to-do moved between done and not done (or restored from deleted)
 *     ticks or unticks its line (`syncNoteLines`, from `TaskRepo.update`):
 *     a personal note by one UPDATE conditional on the text read (read
 *     again on a race), a space note merged into its live text; an agent's
 *     change in a space that takes its note changes as proposals is
 *     proposed instead. A write that fails is owed (`pending_checked`) and
 *     made when the note is next opened by a writer or refreshed
 *     (`healNoteLines`), so the two always come back together;
 *   - a change of the note that ticks or unticks a marked line completes or
 *     reopens its to-do, as the member who made it and within their reach
 *     (`reconcileNoteTasks`): a save (`NoteService.save`), any merged write
 *     (`writeSpaceBody`: a merge, a restored revision, an accepted proposal)
 *     and each update typed in a live note (the hub's `onTicks`, in order);
 *     a marker that only appears or disappears changes nothing.
 * Each side writes only when the other differs, so the two never loop. Every
 * marker names one line and one link: a save takes a copied marker or one
 * without a link off its line (`normalizeMarkers`). A to-do that is archived
 * (deleted) is never brought back by a tick, and archiving one leaves its
 * line as it is. A line deleted from the note leaves the to-do and its link
 * (an undo brings the line back); an edited line keeps its link (the to-do
 * keeps its own title). A repeating to-do's line stays with its occurrence
 * (ticked when it is done); its attached notes move on to the next one, and
 * the note of its line is attached there (db/repositories/task-series.ts);
 * deleting an occurrence hands its links, line included, to the next.
 */
import { StaleWriteError } from '@/core/docs/hub';
import { getNoteService } from '@/core/knowledge/notes';
import { auditTaskMutation } from '@/core/tasks/audit';
import { isActiveStatus } from '@/core/tasks/status';
import { type ContentRepos, contentRepos } from '@/db/repositories/content';
import { type NoteScope, personalNoteScope } from '@/db/repositories/note-repository';
import { memberPrincipal } from '@/db/repositories/space';
import {
  anchoredLinksOfNote, anchorsOfNote, clearAnchors, deleteLink, linksOfNote, linksOfTasks, pendingLinksOfNote, putLink, setPending,
} from '@/db/repositories/task-note-links';
import type { Note } from '@/db/schema/notes';
import type { Task } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import {
  anchorLine, changedAnchors, type LinkedNote, type LinkedTask as SharedLinkedTask, newTodoAnchor, noteTaskLines, setAnchoredChecked, TODO_ANCHOR,
  TODO_MARKER_TAIL, todoTitleFromLine,
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
 * Whether a to-do made now could be linked to `noteId` (at `anchor`): the
 * note in reach and in this scope, the anchor well formed and not another
 * line's to-do. Throws `NoteLinkError` otherwise. Checked before a create,
 * so a refused link makes nothing.
 */
export async function checkNewNoteLink(repos: ContentRepos, input: { noteId: string; anchor?: string | null }): Promise<void> {
  repos.can('write');
  if (input.anchor != null && !TODO_ANCHOR.test(input.anchor)) throw new NoteLinkError('invalid', 'noteAnchor must be 6 to 16 lowercase letters or digits');
  const note = await repos.notes.getById(input.noteId);
  const inScope = !!note && (repos.kind === 'space' ? note.workspaceId === repos.workspaceId : note.userId === repos.principal.userId);
  if (!note || !inScope) throw new NoteLinkError('not_found', 'Note not found');
  if (input.anchor && (await anchoredLinksOfNote(note.id, [input.anchor])).length > 0) {
    throw new NoteLinkError('anchor_taken', 'That line of the note is already another to-do');
  }
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

/** Who a mirrored tick or a reconciled to-do is attributed to (audit, revisions). */
export interface TickActor {
  /** The member or user whose change it is. */
  userId: string;
  /** An agent acting for them (its audit actor and run). */
  agent?: { id: string; sessionId: string | null } | null;
  /** The user a privileged actor (an impersonating admin) acted for. */
  onBehalfOf?: string | null;
}

/**
 * Write a change of a note's body: a space note merged into its current
 * (live) text, a personal note by one UPDATE conditional on the sha it read
 * (read again when another write came first). `change` gets the body as it
 * is and returns the new one, or null for nothing to write. `mirror`: the
 * write is a to-do's state reaching its line (no reconcile back; a closed
 * space note's ticks share one revision a while). Returns whether it wrote.
 */
export async function writeNoteBody(
  scope: NoteScope,
  noteId: string,
  actor: TickActor,
  change: (body: string) => string | null,
  opts: { mirror?: boolean } = {},
): Promise<boolean> {
  const notes = getNoteService();
  for (let attempt = 0; ; attempt++) {
    const note = await notes.getById(scope, noteId);
    if (!note) return false;
    const next = change(note.body);
    if (next === null || next === note.body) return false;
    try {
      if (scope.kind === 'space') {
        await notes.writeSpaceBody(scope, noteId, {
          base: { sha256: note.bodySha256, text: note.body }, next,
          origin: { kind: 'external', userId: actor.userId, onBehalfOfUserId: actor.onBehalfOf ?? null },
          mirror: opts.mirror, actor,
        });
      } else {
        await notes.save({
          scope, id: noteId, title: note.title, body: next, tags: note.tags, ifSha256: note.bodySha256,
          // A to-do's own tick needs no reconcile back.
          skipTaskSync: opts.mirror, deferIndex: true, actor,
        });
      }
      return true;
    } catch (err) {
      if (err instanceof StaleWriteError && attempt < 4) continue;
      throw err;
    }
  }
}

/** A shared space that takes the agent's note changes as proposals (suggest mode). */
async function suggesting(workspaceId: string): Promise<boolean> {
  const { agentEditModeOf } = await import('@/core/spaces/service');
  return (await agentEditModeOf(workspaceId)) === 'suggest';
}

/**
 * A to-do moved between done (`checked`) and not done: tick or untick the
 * note line it was made from, as `principal` (who changed the to-do).
 *
 * An agent's change in a space that takes the agent's note changes as
 * proposals (`agent`, suggest mode) is proposed, as any of its edits there
 * would be (the line follows once a member accepts); everything else is
 * written. A write that fails is owed to the line (`pending_checked`) and
 * made when the note is next opened or refreshed (`healNoteLines`), so
 * line and to-do always come back together. Never throws.
 */
export async function syncNoteLines(
  principal: Principal,
  task: Task,
  checked: boolean,
  opts: { agent?: { sessionId: string | null; agentId: string | null } | null } = {},
): Promise<void> {
  try {
    const links = (await linksOfTasks([task.id])).filter((l) => l.anchor);
    if (links.length === 0) return;
    const repos = contentRepos(principal);
    // A personal to-do's notes are its owner's (made so); a space's, the space's.
    const scope = repos.kind === 'space' ? repos.noteScope : personalNoteScope(task.userId);
    const propose = repos.kind === 'space' && !!opts.agent && await suggesting(repos.workspaceId as string);
    const actor: TickActor = {
      userId: principal.userId,
      agent: opts.agent ? { id: opts.agent.agentId ?? 'agent', sessionId: opts.agent.sessionId } : null,
      onBehalfOf: principal.actorUserId && principal.actorUserId !== principal.userId ? principal.userId : null,
    };
    for (const link of links) {
      const anchor = link.anchor as string;
      try {
        if (propose && opts.agent) {
          // No session to file a proposal under (a pipeline's own close): the line waits for a member.
          if (!opts.agent.sessionId) {
            logger.info({ taskId: task.id, noteId: link.noteId }, 'An agent completed a linked to-do in a suggest-mode space without a session: its line is left for a member');
            continue;
          }
          const { proposeAgentEdit } = await import('@/core/docs/edit-proposals');
          const note = await getNoteService().getById(scope, link.noteId);
          const next = note ? setAnchoredChecked(note.body, anchor, checked) : null;
          if (note && next !== null) await proposeAgentEdit(scope, { sessionId: opts.agent.sessionId, agentId: opts.agent.agentId }, { noteId: note.id, baseSha256: note.bodySha256, body: next });
          continue;
        }
        await writeNoteBody(scope, link.noteId, actor, (body) => setAnchoredChecked(body, anchor, checked), { mirror: true });
        if (link.pendingChecked !== null) await setPending(task.id, link.noteId, null);
      } catch (err) {
        logger.warn({ err, taskId: task.id, noteId: link.noteId }, 'A linked note line could not follow its to-do now; it is owed and made when the note is next opened');
        await setPending(task.id, link.noteId, checked).catch((e: unknown) => logger.error({ err: e, taskId: task.id }, 'The owed tick of a note line was not recorded'));
      }
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'The note lines of a to-do were not synced');
  }
}

/**
 * Make the ticks a note's lines are owed by their to-dos (`syncNoteLines`
 * could not write them), as `userId`, and clear them. Called when the note
 * is opened by someone who may write it and when a live note is refreshed.
 * Never throws.
 */
export async function healNoteLines(scope: NoteScope, noteId: string, userId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(noteId)) return;
  try {
    const owed = await pendingLinksOfNote(noteId);
    for (const link of owed) {
      const anchor = link.anchor as string;
      const checked = link.pendingChecked as boolean;
      try {
        await writeNoteBody(scope, noteId, { userId }, (body) => setAnchoredChecked(body, anchor, checked), { mirror: true });
        await setPending(link.taskId, noteId, null);
      } catch (err) {
        logger.warn({ err, noteId, taskId: link.taskId }, 'An owed note line tick is still owed');
      }
    }
  } catch (err) {
    logger.warn({ err, noteId }, 'The owed ticks of a note were not made');
  }
}

/**
 * A note changed from `before` to `after` by `actor` (a save, a merged
 * write, a live editor's update): complete or reopen the to-dos of the
 * anchored lines whose tick changed, as that member, with their own reach —
 * a to-do they cannot see is left alone. Never throws (the note's change
 * stands; logged).
 */
export async function reconcileNoteTasks(scope: NoteScope, noteId: string, before: string, after: string, actor?: TickActor): Promise<void> {
  const changed = changedAnchors(before, after);
  if (changed.length === 0) return;
  const who: TickActor = actor ?? { userId: scope.userId };
  try {
    const links = await anchoredLinksOfNote(noteId, changed.map((c) => c.anchor));
    if (links.length === 0) return;
    const principal = scope.kind === 'space' ? await memberPrincipal(who.userId, scope.workspaceId) : ownerPrincipal(scope.userId);
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
          actor: who.agent
            ? { kind: 'agent', id: who.agent.id }
            : who.onBehalfOf ? { kind: 'user', id: who.userId, onBehalfOf: who.onBehalfOf } : { kind: 'user', id: who.userId },
          runId: who.agent?.sessionId ?? null,
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
  // A marker with no link here (copied from another note) is no to-do: its line may become one.
  const known = await anchorsOfNote(note.id);
  const lines = noteTaskLines(note.body).filter((l) => !(l.anchor && known.has(l.anchor)) && (wanted ? wanted.has(l.line) : !l.checked));
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
    const wrote = await writeNoteBody(repos.noteScope, note.id, { userId: repos.principal.userId }, (body) => {
      let next = body;
      // Markers that mean nothing here come off first (anchorLine refuses a marked line).
      const unknown = noteTaskLines(body).filter((l) => l.anchor && !known.has(l.anchor) && !made.some((m) => m.anchor === l.anchor));
      for (const l of [...unknown].reverse()) next = `${next.slice(0, l.from)}${next.slice(l.from, l.to).replace(TODO_MARKER_TAIL, '')}${next.slice(l.to)}`;
      const current = noteTaskLines(next);
      const used = new Set<number>();
      for (const m of made) {
        const seen = lines.find((l) => l.line === m.line);
        // Its own line when it still reads the same; else the first unused line that does (two equal lines stay two).
        const free = (l: { line: number; anchor: string | null; text: string }) => !l.anchor && !used.has(l.line) && l.text === seen?.text;
        const at = current.find((l) => l.line === m.line && free(l)) ?? current.find(free);
        if (!at) continue;
        used.add(at.line);
        next = anchorLine(next, at.line, m.anchor) ?? next;
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
