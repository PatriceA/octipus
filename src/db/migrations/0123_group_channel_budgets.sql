-- Spend budgets for a group channel (docs/plans/group-chat-bot.md §8): scope
-- 'group_channel', scope_ref = group_channels.id. The budget counts every
-- cost_log row whose session belongs to the channel, whoever acted; it is
-- filed under the channel's owner, so there is one per channel and period
-- whoever that is (the partial index below), and spend is read through
-- sessions.group_channel_id (the second index).
ALTER TABLE spend_budgets DROP CONSTRAINT IF EXISTS spend_budgets_scope_kind_check;
--> statement-breakpoint
ALTER TABLE spend_budgets ADD CONSTRAINT spend_budgets_scope_kind_check
  CHECK (scope_kind IN ('user','role','workspace','group_channel'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS spend_budgets_group_channel_uniq
  ON spend_budgets(scope_ref, period) WHERE scope_kind = 'group_channel';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_group_channel_idx
  ON sessions(group_channel_id) WHERE group_channel_id IS NOT NULL;
