'use client';

import type { NoteDraft } from './use-note-draft';

/**
 * What the open note's draft offers back from this device, or a save refused
 * because the note changed elsewhere: the user's choice, in one quiet line.
 */
export function DraftNoticeBar({ note }: { note: Pick<NoteDraft, 'draftNotice' | 'keepMine' | 'loadSaved' | 'takeKept' | 'discardKept' | 'dismissNotice'> }) {
  const notice = note.draftNotice;
  if (!notice) return null;
  return (
    <div data-testid="draft-notice" role="status" className="notes-notice">
      {notice.kind === 'stale' ? (
        <>
          This note was changed elsewhere since you opened it. Your text is kept here.
          <button type="button" onClick={note.keepMine} className="font-semibold text-primary underline">Keep my version</button>
          <button type="button" onClick={note.loadSaved} className="underline">Load the saved version</button>
        </>
      ) : notice.kind === 'restored' ? (
        <>
          Restored unsaved changes from this device ({new Date(notice.at).toLocaleString()}).
          <button type="button" onClick={note.dismissNotice} className="underline">OK</button>
        </>
      ) : (
        <>
          This device kept unsaved changes from {new Date(notice.backup.savedAt).toLocaleString()}, but the note has changed since.
          <button type="button" onClick={note.takeKept} className="font-semibold text-primary underline">Use my changes</button>
          <button type="button" onClick={note.discardKept} className="underline">Discard them</button>
        </>
      )}
    </div>
  );
}
