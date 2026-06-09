CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"body_sha256" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"note_kind" text DEFAULT 'note' NOT NULL,
	"note_date" date,
	"created_by_agent_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notes_user_slug_uidx" ON "notes" USING btree ("user_id","slug") WHERE "notes"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_user_ws_slug_uidx" ON "notes" USING btree ("user_id","workspace_id","slug") WHERE "notes"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_user_kind_idx" ON "notes" USING btree ("user_id","note_kind");--> statement-breakpoint
CREATE INDEX "notes_date_idx" ON "notes" USING btree ("user_id","note_date");--> statement-breakpoint
CREATE INDEX "notes_tags_idx" ON "notes" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "notes_active_idx" ON "notes" USING btree ("user_id","updated_at") WHERE "notes"."archived_at" IS NULL;