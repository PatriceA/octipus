-- Phase 2d — channel identities + link codes.
--
-- Replaces the legacy users.channelBindings JSONB column with a
-- proper relational table. Lookup from a channel webhook becomes O(1)
-- on the unique (channel_type, external_id) index, and the binding
-- itself is now per-row deletable (vs. mutating an array column).

CREATE TABLE IF NOT EXISTS "channel_identities" (
  "id"               uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid       NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "channel_type"     text       NOT NULL,
  "external_id"      text       NOT NULL,
  "external_handle"  text,
  "metadata"         jsonb      DEFAULT '{}'::jsonb,
  "verified_at"      timestamp,
  "created_at"       timestamp  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_identities_channel_external_unique"
  ON "channel_identities" ("channel_type", "external_id");
CREATE INDEX IF NOT EXISTS "channel_identities_user_id_idx"
  ON "channel_identities" ("user_id");
CREATE INDEX IF NOT EXISTS "channel_identities_channel_type_idx"
  ON "channel_identities" ("channel_type");

-- Short-lived one-time codes for the channel-binding signup flow.
CREATE TABLE IF NOT EXISTS "channel_link_codes" (
  "id"                    uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"                  text       NOT NULL UNIQUE,
  "channel_type"          text       NOT NULL,
  "external_id"           text       NOT NULL,
  "external_handle"       text,
  "expires_at"            timestamp  NOT NULL,
  "redeemed_at"           timestamp,
  "redeemed_by_user_id"   uuid       REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"            timestamp  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "channel_link_codes_code_idx"        ON "channel_link_codes" ("code");
CREATE INDEX IF NOT EXISTS "channel_link_codes_expires_at_idx"  ON "channel_link_codes" ("expires_at");
