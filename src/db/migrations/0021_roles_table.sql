-- Create roles table for DB-driven role system prompts
CREATE TABLE IF NOT EXISTS "roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" text NOT NULL UNIQUE,
  "tool_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "default_topic" text NOT NULL DEFAULT 'general',
  "system_prompt_template" text NOT NULL,
  "is_system" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
