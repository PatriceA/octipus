CREATE TABLE "knowledge_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_type" text,
	"to_id" uuid,
	"to_ref" text NOT NULL,
	"link_type" text NOT NULL,
	"label" text,
	"origin" text NOT NULL,
	"confidence" real,
	"created_by_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_links_unique_edge_idx" ON "knowledge_links" USING btree ("user_id","from_type","from_id","to_ref","link_type");--> statement-breakpoint
CREATE INDEX "knowledge_links_to_idx" ON "knowledge_links" USING btree ("user_id","to_type","to_id");--> statement-breakpoint
CREATE INDEX "knowledge_links_from_idx" ON "knowledge_links" USING btree ("user_id","from_type","from_id");--> statement-breakpoint
CREATE INDEX "knowledge_links_workspace_idx" ON "knowledge_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_links_ref_idx" ON "knowledge_links" USING btree ("user_id","to_ref");--> statement-breakpoint
CREATE INDEX "knowledge_links_unresolved_idx" ON "knowledge_links" USING btree ("user_id","to_ref") WHERE "knowledge_links"."to_id" IS NULL;