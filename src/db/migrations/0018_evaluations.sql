-- Conformance test runs
CREATE TABLE IF NOT EXISTS conformance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  models JSONB NOT NULL DEFAULT '[]',
  results JSONB NOT NULL DEFAULT '[]',
  summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS conformance_runs_user_id_idx ON conformance_runs (user_id);
CREATE INDEX IF NOT EXISTS conformance_runs_created_at_idx ON conformance_runs (created_at DESC);

-- Evaluation runs
CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  dataset_name TEXT,
  evaluators JSONB NOT NULL DEFAULT '[]',
  results JSONB NOT NULL DEFAULT '[]',
  summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS eval_runs_user_id_idx ON eval_runs (user_id);
CREATE INDEX IF NOT EXISTS eval_runs_created_at_idx ON eval_runs (created_at DESC);
