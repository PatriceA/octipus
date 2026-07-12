ALTER TABLE "agent_events" ADD COLUMN "run_id" text;--> statement-breakpoint
CREATE INDEX "agent_events_run_id_idx" ON "agent_events" USING btree ("run_id");