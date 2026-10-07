-- Spaces across installs (docs/plans/federation-spec.md §8.1).
--
-- federation_instances: the other installs whose members joined a space here
-- (host side). A row is written on the first successful space.join from that
-- install, never on a bare handshake. The peer endpoint reads it on every
-- handshake: a `blocked` instance is refused (4403).
CREATE TABLE IF NOT EXISTS federation_instances (
  instance_id text PRIMARY KEY,
  public_key text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  first_seen timestamptz DEFAULT now() NOT NULL,
  last_seen timestamptz DEFAULT now() NOT NULL,
  blocked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  blocked_at timestamptz
);
--> statement-breakpoint
ALTER TABLE federation_instances DROP CONSTRAINT IF EXISTS federation_instances_status_chk;
--> statement-breakpoint
ALTER TABLE federation_instances ADD CONSTRAINT federation_instances_status_chk CHECK (status IN ('active', 'blocked'));
--> statement-breakpoint
ALTER TABLE federation_instances DROP CONSTRAINT IF EXISTS federation_instances_id_chk;
--> statement-breakpoint
ALTER TABLE federation_instances ADD CONSTRAINT federation_instances_id_chk CHECK (instance_id ~ '^[a-z2-7]{26}$');
