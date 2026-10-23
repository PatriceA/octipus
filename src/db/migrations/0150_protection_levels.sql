-- Protection levels 1-4 (docs/PROTECTION-LEVELS.md). NULL is unclear and counts as 4.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "protection_level" smallint CHECK ("protection_level" BETWEEN 1 AND 4);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "protection_level" smallint CHECK ("protection_level" BETWEEN 1 AND 4);
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN IF NOT EXISTS "protection_level" smallint CHECK ("protection_level" BETWEEN 1 AND 4);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "protection_level" smallint CHECK ("protection_level" BETWEEN 1 AND 4);
--> statement-breakpoint
-- The level new content of a source starts at: records of a type, mail of an account, files of a scan folder.
ALTER TABLE "record_types" ADD COLUMN IF NOT EXISTS "default_protection_level" smallint CHECK ("default_protection_level" BETWEEN 1 AND 4);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN IF NOT EXISTS "default_protection_level" smallint CHECK ("default_protection_level" BETWEEN 1 AND 4);
--> statement-breakpoint
ALTER TABLE "scan_folders" ADD COLUMN IF NOT EXISTS "default_protection_level" smallint CHECK ("default_protection_level" BETWEEN 1 AND 4);
