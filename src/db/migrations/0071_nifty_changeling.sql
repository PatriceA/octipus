CREATE TYPE "public"."swarm_ledger_event" AS ENUM('spawn', 'result', 'cancel', 'reconcile');--> statement-breakpoint
CREATE TABLE "swarm_ledger" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"root_session_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"parent_node_id" text,
	"event" "swarm_ledger_event" NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "swarm_ledger_root_idx" ON "swarm_ledger" USING btree ("root_session_id");--> statement-breakpoint
CREATE INDEX "swarm_ledger_root_seq_idx" ON "swarm_ledger" USING btree ("root_session_id","seq");--> statement-breakpoint
CREATE INDEX "swarm_ledger_node_idx" ON "swarm_ledger" USING btree ("node_id");