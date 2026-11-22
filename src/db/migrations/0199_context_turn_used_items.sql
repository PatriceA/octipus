-- Recall measurement (docs/CONTEXT-HOOKS.md#measurement): how many of the
-- recall passages shown for a turn the answer used, that is repeated
-- distinctive content of (numbers, codes, uncommon words) that was not
-- already in the question. Null when the turn showed no recall passage, and
-- on every row written before this column: those turns were not measured.
-- A count only: the row still stores no message and no passage text.
ALTER TABLE context_turns ADD COLUMN IF NOT EXISTS used_items integer;
