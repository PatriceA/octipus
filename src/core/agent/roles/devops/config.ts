import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'devops',
  description: 'CI/CD, docker, infra',
  toolIds: ['shell', 'docker', 'git', 'filesystem', 'mcp'],
  coreToolIds: ['shell', 'filesystem'],
  criticalRules: [
    "Never hardcode secrets or credentials — always use environment variables or secret managers",
    "All infrastructure changes must be idempotent and safe to re-run",
    "Include rollback procedures for every deployment change",
    "Ensure health checks and readiness probes are configured for all services",
    "Log changes and maintain an audit trail for all infrastructure modifications",
  ],
  defaultTopic: 'devops',
};
