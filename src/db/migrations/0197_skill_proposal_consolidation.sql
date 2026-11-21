-- Fewer, better skill proposals (docs/plans/self-learning-consolidation.md).
--
-- skill_proposal_status gains 'candidate' (filed, not yet shown: a learned
-- proposal waits until it has been seen in enough sessions) and 'merged'
-- (absorbed into another proposal, merged_into_id). A new enum value cannot
-- be used in the transaction that adds it, so nothing below writes either.
--
-- New skill_proposals columns:
--   embedding       embedding of `name\ndescription` (same dimensionless
--                   vector type as skills.description_embedding); NULL until
--                   computed (src/skills/embedding-backfill.ts).
--   source_refs     every sourceRef merged in, newest last, capped at 50.
--   signal          correction | recovery | procedure: the kind of evidence.
--   previous_draft  the draft before the last merge.
--   merged_into_id  the proposal a 'merged' row was absorbed into.
--   surfaced_at     when it became 'pending'.
--
-- Backfill: source_refs = [source_ref] where set; surfaced_at = created_at for
-- pending rows; exemplar_count = 1 where it is 0 on non-expert rows (every
-- skill or patch proposal stands for one observation). New rows start at 1.
ALTER TYPE "skill_proposal_status" ADD VALUE IF NOT EXISTS 'candidate';
--> statement-breakpoint
ALTER TYPE "skill_proposal_status" ADD VALUE IF NOT EXISTS 'merged';
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS embedding vector;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS signal text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS previous_draft text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES skill_proposals(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS surfaced_at timestamptz;
--> statement-breakpoint
ALTER TABLE skill_proposals ALTER COLUMN exemplar_count SET DEFAULT 1;
--> statement-breakpoint
UPDATE skill_proposals SET source_refs = jsonb_build_array(source_ref) WHERE source_ref IS NOT NULL AND source_refs = '[]'::jsonb;
--> statement-breakpoint
UPDATE skill_proposals SET surfaced_at = created_at WHERE status = 'pending' AND surfaced_at IS NULL;
--> statement-breakpoint
UPDATE skill_proposals SET exemplar_count = 1 WHERE exemplar_count = 0 AND kind <> 'expert';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_proposals_merged_into_idx ON skill_proposals (merged_into_id);
