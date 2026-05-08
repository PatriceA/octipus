-- Phase 4 follow-up — per-org SSO + SCIM configuration.
--
-- One row per organization that has identity-provider integration
-- enabled. Rows are populated by an org admin via the admin UI and
-- consumed at runtime by:
--
--   - /saml/:orgSlug/{metadata,login,acs}  (SAML 2.0 SP routes)
--   - /scim/v2/Users  /  /scim/v2/Groups   (SCIM 2.0 inbound)
--
-- The SCIM bearer token is stored as a *vault key reference*
-- (`scim_token_vault_ref`), not the raw token, so the database dump
-- never contains a usable credential. The token itself lives in the
-- vault under `scope='system'`.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "org_sso_config" (
  "org_id"               uuid       PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  -- SAML 2.0 SP-initiated config. NULL when SAML is disabled for the org.
  "saml_enabled"         boolean    NOT NULL DEFAULT false,
  "saml_entity_id"       text,
  "saml_sso_url"         text,
  "saml_x509_cert"       text,
  "saml_attribute_map"   jsonb      NOT NULL DEFAULT '{}',
  -- SCIM 2.0 inbound. NULL when SCIM is disabled.
  "scim_enabled"         boolean    NOT NULL DEFAULT false,
  "scim_token_vault_ref" text,
  "metadata"             jsonb      NOT NULL DEFAULT '{}',
  "created_at"           timestamp  NOT NULL DEFAULT now(),
  "updated_at"           timestamp  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "org_sso_config_saml_enabled_idx"
  ON "org_sso_config" ("saml_enabled") WHERE "saml_enabled" = true;
CREATE INDEX IF NOT EXISTS "org_sso_config_scim_enabled_idx"
  ON "org_sso_config" ("scim_enabled") WHERE "scim_enabled" = true;
