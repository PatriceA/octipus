-- Scan folders: watched server directories filed into documents (docs/SCAN-FOLDERS.md).
CREATE TABLE IF NOT EXISTS "scan_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"label" text NOT NULL,
	"path" text NOT NULL,
	"after_filing" text DEFAULT 'move' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_scan_at" timestamp with time zone,
	"last_error" text,
	"filed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_folders_user_idx" ON "scan_folders" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_folders_workspace_idx" ON "scan_folders" ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scan_folders_path_idx" ON "scan_folders" ("path");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_folder_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folder_id" uuid NOT NULL REFERENCES "scan_folders"("id") ON DELETE cascade,
	"sha256" text NOT NULL,
	"name" text NOT NULL,
	"document_id" uuid,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scan_folder_files_content_idx" ON "scan_folder_files" ("folder_id", "sha256");
--> statement-breakpoint
-- A mail account may file the attachments of received mail into documents (fax-to-mail).
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "file_attachments" boolean DEFAULT false NOT NULL;
