-- A to-do linked to a note (to-dos + notes, step 4): a note attached to the
-- to-do, or the note line the to-do was made from. `anchor` is set for a
-- line, which carries ` ^todo-<anchor>` at its end (src/shared/note-todos.ts);
-- the line's tick and the to-do's status follow each other. One link per
-- (to-do, note); an anchor names one line of one note. Both ends are always
-- in one scope (personal, or one space): enforced where links are made, and
-- read only through the reader's scope on each side.
CREATE TABLE IF NOT EXISTS "task_note_links" (
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "note_id" uuid NOT NULL REFERENCES "notes"("id") ON DELETE CASCADE,
  "anchor" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("task_id", "note_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_note_links_note_idx" ON "task_note_links" ("note_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_note_links_anchor_uidx" ON "task_note_links" ("note_id", "anchor") WHERE "anchor" IS NOT NULL;
