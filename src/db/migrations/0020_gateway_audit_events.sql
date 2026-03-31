-- Add gateway audit action enum values
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'gateway_connection_open';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'gateway_connection_close';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'gateway_auth_success';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'gateway_auth_failure';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'gateway_rate_limit';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'gateway_connection_rejected';
