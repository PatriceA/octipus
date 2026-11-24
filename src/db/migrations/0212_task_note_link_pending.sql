-- A note line that could not yet follow its to-do (the note was being
-- written, out of reach for a moment, its writer gone): the tick it is owed.
-- Written by the to-do side when its write to the line fails, applied and
-- cleared when the note is next opened or refreshed, so line and to-do always
-- come back together (core/tasks/note-links.ts `healNoteLines`).
ALTER TABLE "task_note_links" ADD COLUMN IF NOT EXISTS "pending_checked" boolean;
--> statement-breakpoint
-- A revision that only carries to-dos' ticks into a closed space note: a
-- later tick by the same member joins it rather than adding one per tick.
ALTER TABLE "note_revisions" ADD COLUMN IF NOT EXISTS "tick" boolean DEFAULT false NOT NULL;
