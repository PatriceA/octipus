-- Context hooks (docs/CONTEXT-HOOKS.md): what Octipus injects before an agent
-- starts, per user, and per turn what was injected and what the agent did.
CREATE TABLE IF NOT EXISTS "context_hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"builtin" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"events" text[] NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_hooks_user_idx" ON "context_hooks" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_hooks_builtin_idx" ON "context_hooks" USING btree ("user_id","builtin");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"session_id" text NOT NULL,
	"event" text NOT NULL,
	"role" text,
	"channel" text,
	"agent_id" text,
	"model" text,
	"cli" boolean,
	"hooks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"injected_items" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"knowledge_tool_calls" integer,
	"notes_tool_calls" integer,
	"cited_items" integer,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_turns_user_idx" ON "context_turns" USING btree ("user_id","created_at");
