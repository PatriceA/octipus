-- When an artifact was last opened (an embed render), written at most once
-- an hour per artifact. The retention sweep (artifacts.retentionDays) counts
-- a view as activity: an artifact people open does not expire, even when it
-- is static or its data refreshes fail. Null on existing rows until their
-- next view; for them retention falls back to the edit and refresh times.
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "last_viewed_at" timestamp with time zone;
