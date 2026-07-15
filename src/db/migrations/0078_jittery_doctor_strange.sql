ALTER TABLE "cost_log" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_log" ADD COLUMN "cache_creation_tokens" integer DEFAULT 0 NOT NULL;