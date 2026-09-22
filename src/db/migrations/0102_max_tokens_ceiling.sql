-- 0101 raised default_max_tokens to 16384 and left max_tokens at 4096. The two
-- columns are validated against each other (defaultMaxTokens must not exceed
-- maxTokens), so every row created after that migration was born failing its
-- own validator: a fresh model takes the 4096 column default for its ceiling
-- and 16384 for its per-request default, and the next PATCH of any field at all
-- is rejected with a message about limits the caller never sent. CI caught it
-- on the acceptance fixture, which patches nothing but capability flags.
--
-- The ceiling moves with the default it has to contain. Existing rows are
-- lifted on the same terms 0101 used — only where the model plainly has the
-- room, and only where 4096 was the inherited default rather than a chosen
-- limit (a row whose per-request default is still 4096 chose nothing and keeps
-- its ceiling).
ALTER TABLE model_config ALTER COLUMN max_tokens SET DEFAULT 16384;
--> statement-breakpoint
UPDATE model_config SET max_tokens = 16384
 WHERE max_tokens = 4096 AND default_max_tokens > 4096 AND context_window >= 65536;
