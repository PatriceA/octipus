-- Patch proposals for learned skills and the owner-edit lock
-- (docs/SESSION-LEARNING.md#repairing-a-learned-skill).
--
-- skills.owner_edited_at: when the owner last wrote the skill through the
-- API or the Skills page (create, edit, import). A skill with it set is
-- locked against automatic changes: no patch proposal is filed against it,
-- approving one is refused, and the curator never archives it. Existing
-- non-system skills are backfilled as owner-authored unless a promoted
-- proposal of the same user and normalized name shows they were learned.
--
-- skill_proposals kind 'patch': replace exactly one passage of an existing
-- skill. target_skill_id names the skill, patch_old_text / patch_new_text
-- the passage and its replacement, base_content_hash the sha256 of the
-- skill's content the patch was made against; approval refuses when the
-- content has changed since (stale). Deleting the skill deletes its patches.
ALTER TYPE "skill_proposal_kind" ADD VALUE IF NOT EXISTS 'patch';
--> statement-breakpoint
ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner_edited_at timestamptz;
--> statement-breakpoint
UPDATE skills s SET owner_edited_at = s.updated_at
WHERE s.owner_edited_at IS NULL AND s.is_system = false AND NOT EXISTS (
  SELECT 1 FROM skill_proposals p
  WHERE p.user_id = s.user_id AND p.status = 'promoted'
    AND trim(both '-' from lower(regexp_replace(p.name, '[^a-zA-Z0-9]+', '-', 'g')))
      = trim(both '-' from lower(regexp_replace(s.name, '[^a-zA-Z0-9]+', '-', 'g')))
);
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS target_skill_id text REFERENCES skills(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS patch_old_text text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS patch_new_text text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS base_content_hash text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_proposals_target_skill_idx ON skill_proposals (target_skill_id);
