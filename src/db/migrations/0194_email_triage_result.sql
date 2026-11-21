-- The triage answer the owner was last shown for a mail (priority, category,
-- reason, which model gave it), so the inbox shows it again after a reload.
ALTER TABLE email_triage_labels ADD COLUMN IF NOT EXISTS triage jsonb;
