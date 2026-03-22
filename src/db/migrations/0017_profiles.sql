-- Create profiles table for people/entities the assistant should know about
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  relationship TEXT,
  category TEXT NOT NULL DEFAULT 'person',
  facts JSONB DEFAULT '[]',
  user_id UUID NOT NULL,
  is_user_profile BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS profiles_user_id_idx ON profiles (user_id);
CREATE INDEX IF NOT EXISTS profiles_name_idx ON profiles (name);
