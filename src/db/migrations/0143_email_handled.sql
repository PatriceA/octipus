-- The heartbeat's email check (core/email/watch.ts): which inbox messages an
-- agent was shown and what it did with each. Ids and outcomes only.
CREATE TABLE IF NOT EXISTS "email_handled" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'surfaced' NOT NULL,
	"outcome" text,
	"note" text,
	"task_id" uuid,
	"surfaced_count" integer DEFAULT 0 NOT NULL,
	"surfaced_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_handled_message_idx" ON "email_handled" USING btree ("user_id","provider","message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_handled_recent_idx" ON "email_handled" USING btree ("user_id","created_at");
