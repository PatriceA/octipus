CREATE TYPE "public"."verification_kind" AS ENUM('qa_verdict', 'schema_gate', 'pre_verify', 'adhoc');--> statement-breakpoint
CREATE TABLE "verification_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"pipeline_id" uuid,
	"stage" text,
	"node_id" text,
	"kind" "verification_kind" NOT NULL,
	"passed" boolean NOT NULL,
	"confidence" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_evidence_session_idx" ON "verification_evidence" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "verification_evidence_session_created_idx" ON "verification_evidence" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_evidence_pipeline_idx" ON "verification_evidence" USING btree ("pipeline_id");