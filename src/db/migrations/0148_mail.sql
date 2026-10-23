-- Mail accounts (IMAP / POP3 / SMTP) and their messages (docs/MAIL.md).
CREATE TABLE IF NOT EXISTS "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"protocol" text NOT NULL,
	"incoming" jsonb NOT NULL,
	"outgoing" jsonb,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"local_network" boolean DEFAULT false NOT NULL,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_user_idx" ON "mail_accounts" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_workspace_idx" ON "mail_accounts" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "mail_accounts"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
	"status" text NOT NULL,
	"remote_id" text,
	"message_id_header" text,
	"in_reply_to" text,
	"references" text,
	"from_address" jsonb,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"error" text,
	"author_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_account_date_idx" ON "mail_messages" ("account_id", "date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_messages_remote_idx" ON "mail_messages" ("account_id", "remote_id") WHERE "remote_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_messages_received_idx" ON "mail_messages" ("account_id", "message_id_header") WHERE "status" = 'received' AND "message_id_header" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_raw" (
	"message_id" uuid PRIMARY KEY NOT NULL REFERENCES "mail_messages"("id") ON DELETE cascade,
	"raw" bytea NOT NULL
);
