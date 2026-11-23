/**
 * A copy of a personal note's unsaved edits on this device, so a draft
 * outlives a failed save, a closed tab or a crash. The notes workspace writes
 * it on every change it has not saved yet and removes it once the server has
 * the same text; opening the note again offers it back.
 *
 * Browser storage is a per-device convenience: it can be unavailable (a
 * private window, blocked site data), so every access is guarded and a
 * missing store only means there is no copy. Space notes never use it: their
 * text is a live document the hub saves.
 */

export interface NoteDraftBackup {
  title: string;
  body: string;
  tags: string[];
  noteKind: string;
  /** For a note not created yet: the folder it was going into. */
  folder?: string;
  /** `updatedAt` of the server's note the draft was made from (absent for a new note). */
  baseUpdatedAt?: string;
  /** When the copy was written (ms since epoch). */
  savedAt: number;
}

const PREFIX = 'octipus.note-draft';

/** The storage key of a note's draft in a workspace; `null` id is the note being created. */
export function noteDraftKey(workspaceId: string | null | undefined, noteId: string | null): string {
  return `${PREFIX}.${workspaceId ?? 'personal'}.${noteId ?? 'new'}`;
}

function isBackup(value: unknown): value is NoteDraftBackup {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && typeof v.body === 'string' && Array.isArray(v.tags)
    && typeof v.noteKind === 'string' && typeof v.savedAt === 'number';
}

export function readNoteDraft(key: string): NoteDraftBackup | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBackup(parsed) ? parsed : null;
  } catch (err) {
    console.warn('Reading a saved note draft failed', err);
    return null;
  }
}

export function writeNoteDraft(key: string, draft: NoteDraftBackup): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch (err) {
    // Full or blocked storage: the editor still holds the text.
    console.warn('Keeping a copy of the note draft on this device failed', err);
  }
}

export function removeNoteDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    console.warn('Removing a saved note draft failed', err);
  }
}

/** Whether a draft holds anything the note does not. */
export function draftDiffers(draft: Pick<NoteDraftBackup, 'title' | 'body' | 'tags' | 'noteKind'>, note: { title: string; body: string; tags: string[]; noteKind: string }): boolean {
  return draft.title !== note.title || draft.body !== note.body || draft.noteKind !== note.noteKind
    || draft.tags.length !== note.tags.length || draft.tags.some((t) => !note.tags.includes(t));
}
