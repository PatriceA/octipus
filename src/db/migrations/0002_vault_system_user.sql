-- Allow vault and audit_log to store system-level operations (not tied to a specific user)
-- Change user_id from UUID (with FK to users) to TEXT so 'system' can be used

-- Vault table
ALTER TABLE vault DROP CONSTRAINT IF EXISTS vault_user_id_fkey;
ALTER TABLE vault ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Audit log table
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;
ALTER TABLE audit_log ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
