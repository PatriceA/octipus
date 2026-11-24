import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type TaskNoteLink, taskNoteLinks } from '../schema/tasks';

/**
 * Rows of `task_note_links` (migration 0207), unscoped: every caller reads
 * them for to-dos or a note its own scope already reached, and resolves the
 * other end through its scope again (core/tasks/note-links.ts). Nothing here
 * says whether a caller may see a link.
 */

/** The links of these to-dos. */
export async function linksOfTasks(taskIds: readonly string[]): Promise<TaskNoteLink[]> {
  if (taskIds.length === 0) return [];
  return getDb().select().from(taskNoteLinks).where(inArray(taskNoteLinks.taskId, [...new Set(taskIds)]));
}

/** The links of one note. */
export async function linksOfNote(noteId: string): Promise<TaskNoteLink[]> {
  return getDb().select().from(taskNoteLinks).where(eq(taskNoteLinks.noteId, noteId));
}

/** The links of one note's lines (those with an anchor). */
export async function anchoredLinksOfNote(noteId: string, anchors?: readonly string[]): Promise<TaskNoteLink[]> {
  if (anchors && anchors.length === 0) return [];
  return getDb().select().from(taskNoteLinks).where(and(
    eq(taskNoteLinks.noteId, noteId),
    anchors ? inArray(taskNoteLinks.anchor, [...anchors]) : isNotNull(taskNoteLinks.anchor),
  ));
}

export type PutLinkResult =
  | { ok: true; link: TaskNoteLink; created: boolean }
  /** The anchor already names another to-do's line in this note. */
  | { ok: false; reason: 'anchor_taken' }
  /** The to-do is already linked to a line of this note under another anchor. */
  | { ok: false; reason: 'other_anchor'; anchor: string };

/**
 * Link a to-do and a note (idempotent). With `anchor`, the link is to that
 * line: an attachment without one gets it; one with another anchor is left
 * as it is (`other_anchor`).
 */
export async function putLink(link: { taskId: string; noteId: string; anchor: string | null; createdBy: string | null }): Promise<PutLinkResult> {
  const db = getDb();
  if (link.anchor) {
    const [taken] = await db.select().from(taskNoteLinks)
      .where(and(eq(taskNoteLinks.noteId, link.noteId), eq(taskNoteLinks.anchor, link.anchor))).limit(1);
    if (taken && taken.taskId !== link.taskId) return { ok: false, reason: 'anchor_taken' };
  }
  const [inserted] = await db.insert(taskNoteLinks).values(link).onConflictDoNothing().returning();
  if (inserted) return { ok: true, link: inserted, created: true };
  const [existing] = await db.select().from(taskNoteLinks)
    .where(and(eq(taskNoteLinks.taskId, link.taskId), eq(taskNoteLinks.noteId, link.noteId))).limit(1);
  if (!existing) {
    // The insert lost to the note's anchor index (a concurrent make of the same line).
    return { ok: false, reason: 'anchor_taken' };
  }
  if (!link.anchor || existing.anchor === link.anchor) return { ok: true, link: existing, created: false };
  if (existing.anchor) return { ok: false, reason: 'other_anchor', anchor: existing.anchor };
  const [updated] = await db.update(taskNoteLinks).set({ anchor: link.anchor })
    .where(and(eq(taskNoteLinks.taskId, link.taskId), eq(taskNoteLinks.noteId, link.noteId), isNull(taskNoteLinks.anchor)))
    .returning();
  return updated ? { ok: true, link: updated, created: false } : putLink(link);
}

/** The links of these to-dos to `noteId` become attachments (their lines were never marked). */
export async function clearAnchors(noteId: string, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await getDb().update(taskNoteLinks).set({ anchor: null })
    .where(and(eq(taskNoteLinks.noteId, noteId), inArray(taskNoteLinks.taskId, [...taskIds])));
}

/** Remove the link of a to-do and a note. False when there was none. */
export async function deleteLink(taskId: string, noteId: string): Promise<boolean> {
  const rows = await getDb().delete(taskNoteLinks)
    .where(and(eq(taskNoteLinks.taskId, taskId), eq(taskNoteLinks.noteId, noteId))).returning();
  return rows.length > 0;
}

/**
 * The SQL that gives a repeating to-do's next occurrence the notes of the one
 * before, as attachments (the line stays with the occurrence it was made
 * from). Run inside the transaction that makes the occurrence.
 */
export function copyLinksSql(fromTaskId: string, toTaskId: string) {
  return sql`INSERT INTO task_note_links (task_id, note_id, anchor, created_by)
    SELECT ${toTaskId}::uuid, note_id, NULL, created_by FROM task_note_links WHERE task_id = ${fromTaskId}::uuid
    ON CONFLICT DO NOTHING`;
}
