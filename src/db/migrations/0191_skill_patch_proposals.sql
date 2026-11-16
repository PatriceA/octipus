-- Patch proposals for learned skills and the owner-edit lock
-- (docs/SESSION-LEARNING.md#repairing-a-learned-skill).
--
-- skills.owner_edited_at: when the owner last wrote the skill in person
-- (signed in to the web or mobile app; not an API token or the MCP bridge):
-- created, edited, imported it, or approved a proposal with their own name or
-- text. A skill with it set is locked against automatic changes: no patch
-- proposal is filed against it, approving one is refused, a same-name
-- proposal does not overwrite it, and the curator never archives it.
--
-- No backfill. Nothing recorded so far tells a skill the owner wrote from one
-- they approved (under another name, or merged), and a wrong lock is
-- permanent while a missing one costs a patch proposal the owner can reject;
-- an existing skill locks on the owner's next edit.
--
-- skill_proposals kind 'patch': replace exactly one passage of an existing
-- skill. target_skill_id names the skill, patch_old_text / patch_new_text
-- the passage and its replacement, base_content_hash the sha256 of the
-- skill's content the patch was made against; approval refuses when the
-- content has changed since (stale). Deleting the skill deletes its patches.
--
-- skill_proposals.promoted_skill_id: the skill an approved proposal created,
-- merged into or patched, from now on (NULL for older rows).
ALTER TYPE "skill_proposal_kind" ADD VALUE IF NOT EXISTS 'patch';
--> statement-breakpoint
ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner_edited_at timestamptz;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS target_skill_id text REFERENCES skills(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS patch_old_text text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS patch_new_text text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS base_content_hash text;
--> statement-breakpoint
ALTER TABLE skill_proposals ADD COLUMN IF NOT EXISTS promoted_skill_id text REFERENCES skills(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_proposals_target_skill_idx ON skill_proposals (target_skill_id);
