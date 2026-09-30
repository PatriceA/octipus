-- Per-item acceptance criteria. The planner writes them with the item, and the
-- QA stage must report each one met or not met, with evidence, before its pass
-- counts. Nullable: existing items and items without criteria are judged as
-- before.
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS acceptance jsonb;
