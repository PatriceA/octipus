import type { AgentRole } from '../types';

/**
 * Per-role metadata exported from `roles/<name>/config.ts`.
 * The matching `prompt.md` is loaded by the registry and merged in.
 */
export interface RoleMeta {
  role: AgentRole;
  toolIds: string[];
  defaultTopic: string;
  /**
   * Optional opt-in to lazy tool discovery (see docs/plans/lazy-tool-discovery).
   * When set, only these toolIds are advertised with their full JSON schema on
   * every request; the rest of `toolIds` become a "long tail" reachable via the
   * `list_tools` / `describe_tool` meta-tools (one extra round-trip on first use).
   * Must be a subset of `toolIds` (validated at load time). Absent ⇒ the proven
   * full-schema path (no behavior change). Only takes effect for non-small
   * Ollama models — remote providers prefix-cache the tool block cheaply and
   * stay on full schema.
   */
  /**
   * Behaviour the role must follow, rendered as the numbered "# Critical Rules"
   * block appended to its system prompt (`formatCriticalRules`).
   *
   * These lived on the expert row, which made a child's standing instructions a
   * DATABASE lookup: a seed that had not run, or a row an operator deleted,
   * silently produced a specialist with no rules and nothing said so. They are
   * behaviour for a kind of work, so they belong to the role that does it.
   */
  criticalRules?: string[];
  coreToolIds?: string[];
  /**
   * Strip the file-mutating filesystem handlers (write/append/delete/copy/move/
   * create_directory) from this role's tool surface.
   *
   * For a role whose prompt already promises read-only behavior, this makes the
   * promise real: prose is not a permission boundary, and per-action ASK
   * permissions do not help either, because ASK is auto-approved for every
   * non-root agent role (`tool-executor.ts`, `base-tool.ts`).
   *
   * Only set this where read-only is the role's ACTUAL contract. Several roles
   * are specified to write as their deliverable (architecture saves ADRs, qa
   * authors tests, research saves findings that auto-index to the KB) — setting
   * the flag there changes what the role does and needs its prompt rewritten
   * to match.
   */
  readOnly?: boolean;
}
