-- Cleanup audit log — tracks every knowledge base cleanup run
CREATE TABLE IF NOT EXISTS cleanup_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by TEXT NOT NULL DEFAULT 'manual', -- manual, scheduled, api
  dry_run BOOLEAN NOT NULL DEFAULT false,
  max_age_days INTEGER NOT NULL DEFAULT 30,
  min_content_length INTEGER NOT NULL DEFAULT 50,
  orphaned_documents INTEGER NOT NULL DEFAULT 0,
  stale_agent_outputs INTEGER NOT NULL DEFAULT 0,
  short_entries INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  total_removed INTEGER NOT NULL DEFAULT 0,
  total_before INTEGER, -- KB size before cleanup
  total_after INTEGER,  -- KB size after cleanup
  duration_ms INTEGER,
  created_at TIMESTAMP DEFAULT now() NOT NULL
);

CREATE INDEX cleanup_audit_log_created_at_idx ON cleanup_audit_log (created_at DESC);
