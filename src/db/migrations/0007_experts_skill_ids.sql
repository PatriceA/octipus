-- Add skill_ids column to presets (experts) table for domain knowledge skills
ALTER TABLE "presets" ADD COLUMN IF NOT EXISTS "skill_ids" jsonb DEFAULT '[]'::jsonb;
