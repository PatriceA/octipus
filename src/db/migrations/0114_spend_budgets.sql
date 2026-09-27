-- Dollar spend budgets: a USD cap per user, role or workspace over a UTC day or
-- month, summed from cost_log.total_cost. warned_at / paused_at record the
-- once-per-period warning and the hard pause (src/security/spend-budgets.ts).
-- scope_ref is NULL for the user scope; NULLS NOT DISTINCT keeps a single
-- user-scope row per (user, period).
CREATE TABLE IF NOT EXISTS spend_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('user','role','workspace')),
  scope_ref text,
  period text NOT NULL CHECK (period IN ('day','month')),
  limit_usd numeric NOT NULL CHECK (limit_usd > 0),
  warn_ratio real NOT NULL DEFAULT 0.8,
  warned_at timestamptz,
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS spend_budgets_scope_uniq
  ON spend_budgets(user_id, scope_kind, scope_ref, period) NULLS NOT DISTINCT;
