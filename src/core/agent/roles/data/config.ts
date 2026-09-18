import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'data',
  toolIds: ['data', 'shell', 'filesystem', 'knowledge', 'task_state', 'artifacts', 'artifacts_toolbox', 'documents', 'mcp'],
  // Lazy tool discovery (Ollama, non-small only): hot path is data + shell +
  // filesystem + knowledge. artifacts (~12k) + artifacts_toolbox + task_state become the
  // long tail. NOTE: artifact-building is a primary data-role path, but it's a
  // multi-call flow (create → add widgets/sources/exports), so the single
  // describe_tool round-trip at the start amortizes and the schema stays in
  // context for the rest — worth shedding 12k. No effect on remote providers/
  // small models. See docs/OLLAMA.md.
  coreToolIds: ['data', 'shell', 'filesystem', 'knowledge'],
  criticalRules: [
    "Always include indexes for columns used in WHERE, JOIN, and ORDER BY clauses",
    "Design schemas with data integrity constraints (NOT NULL, UNIQUE, FK) by default",
    "Never run destructive migrations (DROP TABLE/COLUMN) without a backup plan",
    "Consider query performance implications before adding new relationships",
    "Use transactions for multi-step data operations to maintain consistency",
  ],
  defaultTopic: 'data',
};
