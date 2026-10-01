-- Sessions a user marks to keep. The retention sweep (`sessions.retentionDays`,
-- default 14 days) deletes every session idle past the window unless it is
-- pinned. The partial index serves exactly that sweep's predicate.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_unpinned_updated_at_idx ON sessions (updated_at) WHERE pinned = false;
