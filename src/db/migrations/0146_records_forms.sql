-- Record types, records and form links (docs/RECORDS.md).
CREATE TABLE IF NOT EXISTS "record_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title_field" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "record_types_key_idx" ON "record_types" USING btree (coalesce("workspace_id"::text, "user_id"::text),"key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_types_workspace_idx" ON "record_types" USING btree ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"type_id" uuid NOT NULL REFERENCES "record_types"("id") ON DELETE restrict,
	"title" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"source_ref" jsonb,
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_type_idx" ON "records" USING btree ("type_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "records_workspace_idx" ON "records" USING btree ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "records_external_key_idx" ON "records" USING btree (coalesce("workspace_id"::text, "user_id"::text),"external_key") WHERE "external_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_type_id" uuid NOT NULL REFERENCES "record_types"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"intro" text,
	"case_kind" text,
	"expires_at" timestamp with time zone,
	"max_submissions" integer,
	"submission_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_links_token_hash_idx" ON "form_links" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_links_type_idx" ON "form_links" USING btree ("record_type_id");
