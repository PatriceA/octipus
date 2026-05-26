CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" text NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"reason" text,
	"version" text,
	"path" text,
	"installer_kind" text DEFAULT 'manual' NOT NULL,
	"metadata" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capabilities_tool_id_unique" UNIQUE("tool_id")
);
--> statement-breakpoint
CREATE INDEX "capabilities_available_idx" ON "capabilities" USING btree ("available");
