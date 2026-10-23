-- Installed plugin packages (docs/PLUGIN-PACKAGES.md).
CREATE TABLE IF NOT EXISTS "plugin_packages" (
	"name" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
