CREATE TABLE "topics_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"executor_model" text,
	"temperature" real,
	"max_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_config_topic_unique" UNIQUE("topic")
);
--> statement-breakpoint
ALTER TABLE "pipeline_templates" ADD COLUMN "parameters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "tool_ids_customized" boolean DEFAULT false NOT NULL;