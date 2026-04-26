-- Cross-session aggregation hardening.
--
-- One ACTIVE session per (user_id, channel_type, channel_id) for the
-- five aggregated channel types. Keeps the API-side aggregation honest:
-- `findAllByUserAndChannel(...)` already merges sibling sessions across
-- restarts (that's intentional and stays); this guards against TWO
-- concurrent active rows for the same conversation, which would create
-- a fork that the merge can't disentangle.
--
-- - Webchat / api / unknown channels are NOT aggregated and stay free
--   to have many rows (ephemeral by design).
-- - Completed / paused / failed rows don't conflict so historical
--   sessions are preserved untouched.

CREATE UNIQUE INDEX IF NOT EXISTS "sessions_user_channel_active_uniq_idx"
  ON "sessions" ("user_id", "channel_type", "channel_id")
  WHERE "status" = 'active'
    AND "channel_type" IN ('telegram', 'slack', 'whatsapp', 'teams', 'discord');
