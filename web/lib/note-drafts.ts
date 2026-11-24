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
  /** sha256 of the server's body the draft was made from (absent for a new note). */
  baseSha256?: string;
  /** When the copy was written (ms since epoch). */
  savedAt: number;
}

const PREFIX = 'octipus.note-draft';

/**
 * The storage key of a draft in a workspace: `local` is the note's id, or
 * `new-<random>` for a note not created yet (each new note its own key).
 */
export function noteDraftKey(workspaceId: string | null | undefined, local: string): string {
  return `${PREFIX}.${workspaceId ?? 'personal'}.${local}`;
}

/** A fresh `local` key for a note being created. */
export function newDraftLocal(): string {
  return `new-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function storageKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k && k.startsWith(`${PREFIX}.`));
  } catch (err) {
    console.warn('Listing saved note drafts failed', err);
    return [];
  }
}

/** The most recent draft of a note never created, in a workspace (its save failed, or the tab closed first). */
export function latestNewNoteDraft(workspaceId: string | null | undefined): { local: string; draft: NoteDraftBackup } | null {
  const prefix = `${PREFIX}.${workspaceId ?? 'personal'}.new-`;
  let best: { local: string; draft: NoteDraftBackup } | null = null;
  for (const key of storageKeys().filter((k) => k.startsWith(prefix))) {
    const draft = readNoteDraft(key);
    if (draft && (!best || draft.savedAt > best.draft.savedAt)) best = { local: key.slice(prefix.length - 4), draft };
  }
  return best;
}

/** Remove every note draft kept in this browser (signing out: the next person here must not see them). */
export function clearNoteDrafts(): void {
  for (const key of storageKeys()) removeNoteDraft(key);
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
