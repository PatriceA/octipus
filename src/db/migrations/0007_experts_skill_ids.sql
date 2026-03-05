-- Add tool_ids and skill_ids columns to presets (experts) table
ALTER TABLE "presets" ADD COLUMN IF NOT EXISTS "tool_ids" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "presets" ADD COLUMN IF NOT EXISTS "skill_ids" jsonb DEFAULT '[]'::jsonb;
