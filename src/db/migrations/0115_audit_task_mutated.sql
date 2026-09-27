-- Audit rows for task mutations (create / update / complete / delete). ADD VALUE
-- runs inside the migrator's transaction; PG12+ allows that as long as the new
-- value is not used in the same transaction, and this file never uses it.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'task_mutated';
