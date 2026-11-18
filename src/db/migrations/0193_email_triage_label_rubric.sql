-- The priority rubric a reference model's label was given: a label from an
-- older rubric answered a different question and is ignored by calibration.
ALTER TABLE email_triage_labels ADD COLUMN IF NOT EXISTS label_rubric text;
