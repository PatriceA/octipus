-- Skill curator lifecycle fields (Phase 4 — Hermes-inspired learning loop).
--
-- Adds:
--   * last_used_at   — bumped by the usage tracker each time a skill is
--                      injected into a prompt (registry.ts → emit
--                      `skill.usage` → usage-tracker repository call).
--   * usage_count    — lifetime counter for the same event.
--   * archived_at    — soft-archive flag set by the curator. Archived
--                      skills stay in the table for audit but drop out
--                      of `findActiveByTopic` / discovery results.
--   * curation_notes — free-form text the curator can leave on a skill
--                      (auto-archive reason, refresh suggestion, etc.).
--
-- A partial index on last_used_at speeds the curator's stale scan
-- (WHERE last_used_at < cutoff AND archived_at IS NULL).
--
-- Idempotent: safe to rerun.

ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "usage_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "curation_notes" text;

CREATE INDEX IF NOT EXISTS "skills_last_used_idx"
  ON "skills" ("last_used_at");
