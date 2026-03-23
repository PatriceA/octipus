-- Fix session deletion blocked by pipeline FK constraint
ALTER TABLE "pipelines" DROP CONSTRAINT IF EXISTS "pipelines_session_id_sessions_id_fk";
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_session_id_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;
