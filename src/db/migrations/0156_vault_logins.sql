-- User/workspace logins encrypt username and password together in the vault.
ALTER TYPE "credential_type" ADD VALUE IF NOT EXISTS 'login';
