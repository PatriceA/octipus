-- Per-user daily token quotas are a SPEND proxy, but `agents.total_tokens` became
-- a cache-inflated grand total once prompt-cache counters were folded into
-- `inputTokens`. Record the billable figure (fresh input + output) alongside it so
-- the quota sums spend while the UI keeps showing context volume.
-- NULL (not 0) on legacy rows so the quota can COALESCE back to total_tokens.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS billable_tokens integer;
