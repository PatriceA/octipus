-- Artifact slugs are unique per workspace among LIVE artifacts only. The
-- index covered deleted rows too, so a deleted artifact kept its slug taken
-- for the 30 days it sits in the trash (or longer with artifacts.trashDays),
-- and creating a new artifact under it failed with "slug already used" for
-- an artifact nobody could see. Every pair the old index allowed is allowed
-- by the new one, so the swap cannot fail on existing rows.
DROP INDEX IF EXISTS "artifacts_workspace_id_slug_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_workspace_id_slug_uq" ON "artifacts" ("workspace_id", "slug") WHERE "deleted_at" IS NULL;
