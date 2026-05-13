-- Convert every bare `timestamp` column in the public schema to `timestamptz`.
--
-- Why this is needed
-- ──────────────────
-- The schema originally used `TIMESTAMP NOT NULL DEFAULT NOW()`. Postgres
-- stores those as `timestamp without time zone` (a naked wall-clock value
-- with no TZ info). `NOW()` returns `timestamptz`, which is cast to the
-- session TZ on insert. When the API process (Node) runs in a different
-- TZ than the DB session, or when callers pass a JS Date through Drizzle
-- (which serializes with `Z`), reads come back interpreted under the
-- client's locale — and two records created at the same instant can
-- present as one hour apart in JSON output. The chat UI saw exactly that
-- (agent createdAt and user-message createdAt differed by 1h despite
-- being saved within milliseconds of each other).
--
-- `timestamptz` removes the ambiguity: it always stores UTC and serializes
-- as UTC regardless of session TZ.
--
-- Conversion strategy
-- ───────────────────
-- For each bare-timestamp column: ALTER TYPE to `timestamptz`, interpreting
-- the existing value under the *current* session timezone. This preserves
-- wall-clock meaning as long as the session TZ matches what was used at
-- insert time (Postgres default is whatever `timezone` GUC is — usually
-- 'UTC' or the host TZ). If you ran the DB on a different TZ historically,
-- adjust `current_setting('timezone')` to the historical value before
-- running this migration.
--
-- Idempotent: the loop only touches columns still typed as
-- `timestamp without time zone`, so re-running is a no-op.

DO $$
DECLARE
  r record;
  sql_text text;
BEGIN
  FOR r IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
    ORDER BY table_name, column_name
  LOOP
    sql_text := format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE current_setting(''timezone'')',
      r.table_schema, r.table_name, r.column_name, r.column_name
    );
    EXECUTE sql_text;
  END LOOP;
END $$;
