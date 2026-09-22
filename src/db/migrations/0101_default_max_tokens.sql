-- A reasoning model's thinking counts against max_tokens. With the stored
-- default of 4096 a model that thought for ~2k tokens and then wrote a 14 KB
-- file was cut off mid tool call, twice in one run (2026-09-17). New rows get
-- 16384; existing rows still at the old default are lifted with them — but only
-- where the model plainly has the room (a 64k+ context), since the column does
-- not record whether 4096 was inherited or chosen, and a small model's real
-- output ceiling must not be overshot.
ALTER TABLE model_config ALTER COLUMN default_max_tokens SET DEFAULT 16384;
--> statement-breakpoint
UPDATE model_config SET default_max_tokens = 16384 WHERE default_max_tokens = 4096 AND context_window >= 65536;
