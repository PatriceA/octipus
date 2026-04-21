-- Trajectory logging: pointer rows for per-run JSONL records
CREATE TYPE "trajectory_outcome" AS ENUM ('success', 'failure', 'partial', 'cancelled');

CREATE TABLE IF NOT EXISTS "trajectory_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "outcome" "trajectory_outcome" NOT NULL,
  "started_at" timestamp NOT NULL,
  "ended_at" timestamp NOT NULL,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "jsonl_path" text NOT NULL,
  "jsonl_line" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "trajectory_runs_user_idx" ON "trajectory_runs" ("user_id");
CREATE INDEX IF NOT EXISTS "trajectory_runs_session_idx" ON "trajectory_runs" ("root_session_id");
CREATE INDEX IF NOT EXISTS "trajectory_runs_outcome_idx" ON "trajectory_runs" ("outcome");
CREATE INDEX IF NOT EXISTS "trajectory_runs_started_at_idx" ON "trajectory_runs" ("started_at");

-- Skill auto-extension: proposals await user approval before becoming experts
CREATE TYPE "skill_proposal_status" AS ENUM ('pending', 'approved', 'rejected', 'promoted');

CREATE TABLE IF NOT EXISTS "skill_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "draft_prompt_template" text NOT NULL,
  "exemplar_count" integer NOT NULL DEFAULT 0,
  "last_exemplar_at" timestamp NOT NULL,
  "status" "skill_proposal_status" NOT NULL DEFAULT 'pending',
  "rejected_until" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "skill_proposals_user_idx" ON "skill_proposals" ("user_id");
CREATE INDEX IF NOT EXISTS "skill_proposals_fingerprint_idx" ON "skill_proposals" ("fingerprint");
CREATE INDEX IF NOT EXISTS "skill_proposals_status_idx" ON "skill_proposals" ("status");
