-- One listen probe per room across processes (docs/plans/coworking-spec.md §9.3).
--
-- Every instance running cron reads a room's transcript from the database, so
-- each would probe — and pay for — the same unanswered question. The gate
-- claims the probe on the room's mode row first, with a conditional UPDATE
-- (`claimRoomProbe`): at most one probe per room per `PROBE_INTERVAL_MS`, and
-- never twice for the same question, whichever process asks.
ALTER TABLE room_modes ADD COLUMN IF NOT EXISTS last_probe_at timestamptz;
--> statement-breakpoint
ALTER TABLE room_modes ADD COLUMN IF NOT EXISTS last_probed_message_id uuid;
