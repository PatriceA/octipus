CREATE TABLE "workspace_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"root_path" text NOT NULL,
	"remote_url" text,
	"default_branch" text,
	"kind" text DEFAULT 'unknown' NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"package_name" text,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repo_map" text,
	"has_agents_md" boolean DEFAULT false NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repos_user_path_uidx" ON "workspace_repos" USING btree ("user_id","root_path");--> statement-breakpoint
CREATE INDEX "workspace_repos_user_idx" ON "workspace_repos" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_repos_package_name_idx" ON "workspace_repos" USING btree ("package_name");