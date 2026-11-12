/** Out-of-box spend budgets. Explicit installation, user, session and run caps win. */
export const TOKEN_BUDGET_DEFAULTS = {
  general: 10_000_000,
  pipeline: 10_000_000,
  root: 2_000_000,
  agent: 800_000,
  subagent: 300_000,
  pluginDaily: 10_000_000,
  pluginRun: 1_000_000,
} as const;
