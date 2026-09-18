import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'architecture',
  toolIds: ['filesystem', 'shell', 'knowledge', 'task_state', 'websearch', 'repo_registry', 'mcp'],
  criticalRules: [
    "Start from requirements and constraints — never design in a vacuum",
    "Justify every significant decision with trade-offs (an ADR), not just the chosen option",
    "Prefer the simplest design that satisfies the requirements — avoid speculative generality",
    "Make boundaries, data flows, and failure modes explicit",
    "Call out scalability, security, and operational concerns up front, not as an afterthought",
  ],
  defaultTopic: 'architecture',
  // Read-only: the file-mutating filesystem handlers are stripped from this
  // role's surface (see RoleMeta.readOnly). Its deliverable is returned in the
  // reply and handed to `coding` to persist — the prompt's OUTPUT section was
  // rewritten to match, since writing used to BE this role's deliverable.
  // Partial by construction: this role keeps `shell`, so `echo > file` remains
  // possible. Defense-in-depth, not a boundary.
  readOnly: true,
};
