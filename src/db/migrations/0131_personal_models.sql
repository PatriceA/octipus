-- Own models (docs/plans/coworking-spec.md §8.1, S4).
--
-- A personal model row belongs to one user: `owner_user_id` set, name
-- `u/<userId>/<slug>`. Ownership is the column, never the name. Install-level
-- registry queries filter `owner_user_id IS NULL`, so a personal row is never a
-- default, a topic model or a fallback for anyone else.
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_config_owner_user_id_idx ON model_config(owner_user_id);
--> statement-breakpoint
-- Personal topic bindings. Kept apart from `model_config.topic_roles`, which the
-- admin topics route rewrites wholesale (`PUT /api/topics`). One primary per
-- (user, topic); the row it names must be the user's own (checked on write).
CREATE TABLE IF NOT EXISTS user_model_bindings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic      text NOT NULL,
  model_name text NOT NULL REFERENCES model_config(name) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_model_bindings_model_idx ON user_model_bindings(model_name);
--> statement-breakpoint
-- An owner created, changed or deleted a personal model (their audit trail).
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'personal_model_changed';
