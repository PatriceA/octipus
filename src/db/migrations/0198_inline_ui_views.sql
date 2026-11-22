-- Interactive answers, part 2: declarative views (docs/plans/inline-ui-views-spec.md §6).
--
-- kind   'html' (part 1: css/html/js run in a sandboxed frame) or 'view' (a
--        JSON description of catalog components the web renders natively).
-- view   the normalized view (`InlineUiView`); null for an HTML block.
-- state  the last answer sent from a view (`InlineUiViewState`: the data
--        model at the click and the event); null until someone answers.
ALTER TABLE inline_ui_blocks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'html';
--> statement-breakpoint
ALTER TABLE inline_ui_blocks ADD COLUMN IF NOT EXISTS view jsonb;
--> statement-breakpoint
ALTER TABLE inline_ui_blocks ADD COLUMN IF NOT EXISTS state jsonb;
--> statement-breakpoint
ALTER TABLE inline_ui_blocks DROP CONSTRAINT IF EXISTS inline_ui_blocks_kind_chk;
--> statement-breakpoint
ALTER TABLE inline_ui_blocks ADD CONSTRAINT inline_ui_blocks_kind_chk CHECK (kind IN ('html', 'view') AND (kind = 'html' OR view IS NOT NULL));
