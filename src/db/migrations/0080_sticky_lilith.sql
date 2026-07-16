CREATE TYPE "public"."skill_proposal_kind" AS ENUM('skill', 'expert');--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD COLUMN "kind" "skill_proposal_kind" DEFAULT 'expert' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_proposals" ADD COLUMN "source_ref" text;