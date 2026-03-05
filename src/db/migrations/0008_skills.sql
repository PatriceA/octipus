-- Domain knowledge skills table
CREATE TABLE IF NOT EXISTS "skills" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "category" text NOT NULL DEFAULT 'engineering',
  "description" text NOT NULL,
  "principles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "best_practices" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "anti_patterns" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "frameworks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_system" boolean NOT NULL DEFAULT false,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
