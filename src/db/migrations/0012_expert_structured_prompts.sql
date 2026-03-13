-- Add structured prompt fields to presets (experts) table
ALTER TABLE "presets" ADD COLUMN IF NOT EXISTS "critical_rules" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "presets" ADD COLUMN IF NOT EXISTS "deliverable_template" text;
ALTER TABLE "presets" ADD COLUMN IF NOT EXISTS "success_metrics" jsonb DEFAULT '[]'::jsonb;
