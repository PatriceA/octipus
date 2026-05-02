-- Phase 1b-2 — per-user data-encryption keys (DEK).
--
-- Adds a `key_version` discriminator to vault rows so the vault layer
-- can tell which derivation scheme was used when a row was encrypted:
--   1 = legacy PBKDF2(masterKey, fixed salt) — every row shares one key.
--   2 = HKDF(masterKey, salt=userId, info=scope+userId) — per-(scope,user) DEK.
--
-- Existing rows stay at version 1; future writes default to version 2
-- (set by the vault code, not the column default — the column default
-- stays at 1 so an out-of-band INSERT that doesn't pass the column
-- still lands somewhere decryptable). A follow-up commit ships the
-- batch re-encryption helper that walks v1 rows and rewrites them at v2.

ALTER TABLE "vault" ADD COLUMN IF NOT EXISTS "key_version" integer NOT NULL DEFAULT 1;
