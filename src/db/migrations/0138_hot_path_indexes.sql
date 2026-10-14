-- Composite indexes for two hot reads that only had single-column ones.
--
-- messages: `findContextMessages` (every cold prompt) filters on session_id
-- and orders by created_at DESC, id DESC with a LIMIT. With only
-- messages_session_id_idx, Postgres fetched the whole session and sorted it.
-- (session_id, created_at, id) serves the filter, the order and the limit,
-- and its leading column serves every session_id lookup the old index did
-- (including the ON DELETE CASCADE from sessions), so that one is dropped
-- rather than maintained twice on the busiest insert path.
--
-- cost_log: the spend budgets (`spendSince`, src/security/spend-budgets.ts)
-- sum a user's rows since the period start on every model call (behind a
-- 30 s cache). (user_id, created_at) replaces cost_log_user_id_idx the same
-- way.
CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages (session_id, created_at, id);
--> statement-breakpoint
DROP INDEX IF EXISTS messages_session_id_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_log_user_created_idx ON cost_log (user_id, created_at);
--> statement-breakpoint
DROP INDEX IF EXISTS cost_log_user_id_idx;
