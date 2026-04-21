-- Swarm Phase 1: nodes in the agent delegation tree (Orchestrator → Agent).
-- Schema mirrors `.assistant/swarm-design.md` §Observability.

CREATE TYPE "swarm_node_kind" AS ENUM ('orchestrator', 'agent', 'subagent');
CREATE TYPE "swarm_node_status" AS ENUM (
  'running',
  'completed',
  'budget',
  'timeout',
  'denied',
  'tool_error',
  'provider_error',
  'cancelled',
  'concurrency_limit',
  'cache_hit'
);

CREATE TABLE IF NOT EXISTS "swarm_nodes" (
  "id" text PRIMARY KEY,                       -- = agents.id (1:1)
  "root_session_id" uuid NOT NULL,
  "parent_node_id" text,                        -- null for Orchestrator
  "depth" integer NOT NULL,
  "kind" "swarm_node_kind" NOT NULL,
  "role" text NOT NULL,
  "expert_id" uuid,
  "topic_path" text NOT NULL,
  "subtopic" text,
  "model" text NOT NULL,
  "status" "swarm_node_status" NOT NULL DEFAULT 'running',
  "token_cap" integer NOT NULL,
  "tokens_used" integer NOT NULL DEFAULT 0,
  "wall_clock_cap_ms" integer NOT NULL,
  "fan_out_cap" integer NOT NULL,
  "fan_out_used" integer NOT NULL DEFAULT 0,
  "brief_hash" text NOT NULL,
  "cache_hits" integer NOT NULL DEFAULT 0,
  "result" jsonb,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "swarm_nodes_root_idx" ON "swarm_nodes" ("root_session_id");
CREATE INDEX IF NOT EXISTS "swarm_nodes_parent_idx" ON "swarm_nodes" ("parent_node_id");
CREATE INDEX IF NOT EXISTS "swarm_nodes_status_idx" ON "swarm_nodes" ("status");
CREATE INDEX IF NOT EXISTS "swarm_nodes_brief_hash_idx" ON "swarm_nodes" ("brief_hash");

-- Agents table: link rows to their swarm parent & node (nullable — non-swarm agents unaffected)
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "parent_agent_id" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "swarm_node_id" text;
