-- Install models per user (docs/SPACES.md → Who may use the install's models).
-- An account either may run on the install's models and keys or only on its
-- own models (Settings → My models) and what a space sponsors. Accounts keep
-- what they had; only an account created on the sign-in page starts without
-- it, unless `security.selfRegisteredInstallModels` is on (registration.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS install_models boolean DEFAULT true NOT NULL;
