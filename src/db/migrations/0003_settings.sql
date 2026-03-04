-- Runtime settings table: stores non-bootstrap configuration that can be changed without restart
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  category TEXT NOT NULL,
  description TEXT,
  default_value TEXT,
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS settings_category_idx ON settings(category);
