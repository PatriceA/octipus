-- Companion decisions answerable as approvals, and reports held for quiet hours.
ALTER TABLE companion_incidents ADD COLUMN IF NOT EXISTS decision_revision integer;
ALTER TABLE companion_incidents ADD COLUMN IF NOT EXISTS decision_request_id uuid;
ALTER TABLE companion_reports ADD COLUMN IF NOT EXISTS deferred_until timestamptz;
ALTER TABLE companion_reports ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS companion_reports_deferred_idx ON companion_reports (deferred_until) WHERE deferred_until IS NOT NULL;
-- Escalations from before this change keep their Companion-page decision; only new ones are asked.
UPDATE companion_incidents SET decision_revision = revision WHERE state = 'escalated' AND decision_revision IS NULL;
-- Delivery time drives the daily cap; 'sending' marks a report whose message is being posted.
ALTER TABLE companion_reports ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
UPDATE companion_reports SET delivered_at = created_at WHERE decision = 'delivered' AND delivered_at IS NULL;
ALTER TABLE companion_reports DROP CONSTRAINT IF EXISTS companion_reports_decision_chk;
ALTER TABLE companion_reports ADD CONSTRAINT companion_reports_decision_chk CHECK (decision IN ('delivered', 'sending', 'recorded'));
