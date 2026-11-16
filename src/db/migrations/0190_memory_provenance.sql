-- Memory provenance and temporal hygiene (docs/RAG.md#where-a-memory-comes-from).
--
-- source_quote   the owner's own words a memory rests on, verified against a
--                cited role='user' message before the row was written.
-- kind           fact | preference | plan | event | possession.
-- status         tentative (one message) | observed (several) | stated (asked
--                to be remembered).
-- expires_at     when the fact itself stops being true; recall skips it from
--                then on and the repair pass retires it.
-- archive_reason why a row stopped being active.
--
-- All nullable: rows written before this migration keep working and are
-- still recalled. Idempotent: safe to rerun.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_quote text;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_reason text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_kind_check
    CHECK (kind IS NULL OR kind IN ('fact', 'preference', 'plan', 'event', 'possession'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_status_check
    CHECK (status IS NULL OR status IN ('tentative', 'observed', 'stated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_archive_reason_check
    CHECK (archive_reason IS NULL OR archive_reason IN ('superseded', 'contradicted', 'expired', 'merged', 'stale'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_source_quote_len_check
    CHECK (source_quote IS NULL OR char_length(source_quote) <= 400);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS memories_expires_at_idx
  ON memories (expires_at) WHERE expires_at IS NOT NULL;
--> statement-breakpoint
-- The view expands `*` when it is created, so it is rebuilt to carry the new
-- columns, and it now also hides a fact past its expires_at.
DROP VIEW IF EXISTS memories_active;
--> statement-breakpoint
CREATE VIEW memories_active AS
  SELECT *
    FROM memories
   WHERE superseded_by IS NULL
     AND (valid_until IS NULL OR valid_until > now())
     AND (expires_at IS NULL OR expires_at > now());
