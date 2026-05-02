-- Phase 2a — personal access tokens.
--
-- Non-browser clients (CI, MCP, scripts, browser extension) authenticate
-- with bearer tokens of the form `octi_<43-char-base64url>`. Only the
-- SHA-256 hash is stored; the plaintext is shown once at creation.
-- Replaces the MASTER_KEY Bearer fallback once `multiuser.enabled` is on.

CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name"         text        NOT NULL,
  "token_hash"   text        NOT NULL UNIQUE,
  "prefix"       text        NOT NULL,
  "scopes"       text[]      NOT NULL DEFAULT '{}'::text[],
  "metadata"     jsonb       DEFAULT '{}'::jsonb,
  "expires_at"   timestamp,
  "last_used_at" timestamp,
  "revoked_at"   timestamp,
  "created_at"   timestamp   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "api_tokens_user_id_idx"     ON "api_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "api_tokens_token_hash_idx"  ON "api_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "api_tokens_revoked_at_idx"  ON "api_tokens" ("revoked_at");
