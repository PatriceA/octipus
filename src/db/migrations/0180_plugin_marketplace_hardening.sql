-- The plugin marketplace, hardened (docs/PLUGIN-PACKAGES.md#marketplace-keys).
--
-- plugin_marketplace_keys.endorsed_key_ids: every signing key any accepted
-- keys.json listed. keys.json may revoke only these keys (and the roots), so a
-- root cannot be used to revoke a key it never vouched for. Backfilled from the
-- keys file stored now.
ALTER TABLE plugin_marketplace_keys ADD COLUMN IF NOT EXISTS endorsed_key_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
UPDATE plugin_marketplace_keys SET endorsed_key_ids = COALESCE(
  (SELECT jsonb_agg(k->>'keyId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(body::jsonb->'signingKeys') = 'array' THEN body::jsonb->'signingKeys' ELSE '[]'::jsonb END) k),
  '[]'::jsonb)
WHERE endorsed_key_ids = '[]'::jsonb;
--> statement-breakpoint
-- plugin_listing_pins.signed_by: the key that signed the index that first
-- listed the version. A pin whose signer is revoked since holds nothing back
-- (a leaked key cannot squat a future version).
ALTER TABLE plugin_listing_pins ADD COLUMN IF NOT EXISTS signed_by text;
