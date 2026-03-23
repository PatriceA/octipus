-- Add markdown content field to skills (Claude Code-style skill definitions)
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "content" text DEFAULT '';
