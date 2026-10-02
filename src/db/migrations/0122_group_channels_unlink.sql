-- Follow-up to 0121 (found in review before release):
--  - sessions.group_channel_id loses its foreign key. With ON DELETE SET NULL,
--    removing an enrolment turned a member's several thread sessions in one
--    channel into colliding 1:1 rows (sessions_user_channel_active_uniq_idx),
--    so the delete failed; and surviving sessions stopped being group sessions.
--    The marking must outlive the enrolment.
--  - group_channels.workspace_id is dropped: every turn runs in the asking
--    member's own workspace, so a channel-level workspace had no effect.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_group_channel_id_fkey;
--> statement-breakpoint
ALTER TABLE group_channels DROP COLUMN IF EXISTS workspace_id;
