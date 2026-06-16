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
  coreToolIds?: string[];
}
