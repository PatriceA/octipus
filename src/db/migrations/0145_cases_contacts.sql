-- Cases ("Vorgänge"), contacts and what a case links to (docs/CASES.md), and
-- follow-up dates on tasks ("Wiedervorlagen", core/tasks/reminders.ts).
CREATE TABLE IF NOT EXISTS "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"title" text NOT NULL,
	"kind" text,
	"status" text DEFAULT 'open' NOT NULL,
	"summary" text,
	"assignee_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"source" text DEFAULT 'user' NOT NULL,
	"source_ref" jsonb,
	"external_key" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_user_status_idx" ON "cases" USING btree ("user_id","status","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_workspace_status_idx" ON "cases" USING btree ("workspace_id","status","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cases_external_key_idx" ON "cases" USING btree (coalesce("workspace_id"::text, "user_id"::text),"external_key") WHERE "external_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL REFERENCES "cases"("id") ON DELETE cascade,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_links_unique_idx" ON "case_links" USING btree ("case_id","entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_links_entity_idx" ON "case_links" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"kind" text DEFAULT 'person' NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" jsonb,
	"organization_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_user_name_idx" ON "contacts" USING btree ("user_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_workspace_name_idx" ON "contacts" USING btree ("workspace_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_organization_idx" ON "contacts" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_external_key_idx" ON "contacts" USING btree (coalesce("workspace_id"::text, "user_id"::text),"external_key") WHERE "external_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "remind_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reminded_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_due_reminder_idx" ON "tasks" USING btree ("remind_at") WHERE "remind_at" IS NOT NULL AND "reminded_at" IS NULL;
