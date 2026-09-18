import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'automation',
  description: 'scheduling, recurring tasks, reminders',
  toolIds: ['shell', 'docker', 'filesystem', 'scheduling', 'mcp'],
  criticalRules: [
    "ALWAYS use the built-in scheduling tool (create_hook) for recurring tasks — NEVER write standalone scripts, cron files, systemd services, or plugins",
    "For recurring tasks: use create_hook with trigger \"schedule\", a cronExpression, and action \"spawn_agent\" with an agentPrompt",
    "For notifications: use the messaging tool (send_message) to send to the user\'s existing channels — do NOT build custom notification systems",
    "All automations must be idempotent — safe to re-run without side effects",
    "Design for failure — assume any external call can fail, include retry logic in the agent prompt",
    "Never automate destructive actions without confirmation gates",
  ],
  defaultTopic: 'automation',
};
